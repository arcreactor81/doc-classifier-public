import {
  checkSpendAdmission,
  confidenceTooLargeRefusal,
  emptyBody,
  isolatesUnknownSpend,
  notProcessedAttempt
} from '../cost/spend-admission.ts';
import { ValidationFailure } from '../vendors/validate.ts';
import { readerEvidencePolicy } from '../vendors/evidence-policy.ts';
import {
  providerScope,
  readProviderCooldown,
  observeProviderCooldown,
  awaitProviderAdmission
} from './provider-cooldown.ts';
import type { WorkflowStep } from 'cloudflare:workers';
import { usageCachePolicy, type ProjectPack } from '../config/project.ts';
import { actualUsageCost, chatUsageCost } from '../cost/cost.ts';
import { readRunBudget } from '../cost/run-budget.ts';
import {
  executeVendor,
  type CallLog,
  type RawAttempt,
  type TransportDependencies
} from '../vendors/transport.ts';
import {
  buildConfidenceRequest,
  decodeConfidence,
  requestVendor,
  verifyModelPolicy,
  type FrozenVendorRequest,
  type RequestVendor,
  type VendorRole
} from '../vendors/requests.ts';
import {
  SINGLE_CONFIDENCE_POLICY,
  buildConfidenceRequests,
  confidenceQuestionPolicy,
  decodeConfidenceGroup,
  mergeConfidenceGroups,
  packQuestionBudget,
  type ConfidenceGroupAnswer
} from '../vendors/confidence-grouping.ts';
import { outbound } from '../vendors/outbound.ts';
import { Store, spendFromRow, unknownFromRow, type RunRow } from './store.ts';
import { checkpoint, type StageResult } from './checkpoint.ts';
import { readD1, d1WriteBackoff, D1_WRITE_ATTEMPTS } from './d1-write-policy.ts';
import { readR2 } from './r2-write-policy.ts';
import type { ArtifactRegistration } from './artifact-persistence.ts';
import { persistCircuitOutcome, storageCircuitFailure } from './circuit-persistence.ts';
import { workflowReference } from './workflow-ack.ts';
import { workflowWait } from './workflow-wait.ts';
import { pricingFor } from './capabilities.ts';
import { ServerFailure, failure, recordedWorkflowRuntimeDiagnostic, serverCopy, CHARGE_STORAGE_CODES, DOCUMENT_STORAGE_CODES } from './errors.ts';
import { requireBakeoffExecution } from './bakeoff-execution.ts';
import { assertRuntimeDeadline, claimNativeRuntimeEntry, deferUnenteredRuntime, DeferredRuntimeInterruption, SupersededRuntimeEntry, RUNTIME_INTERRUPTION_LIMIT, RUNTIME_WAIT_MS, type RuntimeFrame } from './runtime-interruption.ts';
import { enforceRuntimeDeadline } from './runtime-settlement.ts';
import { unknownChargeIsolated, unaccountedAttempts } from './unknown-charge.ts';
import { readerContextBound, reservationForRequest } from '../vendors/input-token-count.ts';
import { usageCopy } from '../ui/copy-usage.ts';
import { assertDailyUsage, cancelUnsentDailyReservation, confirmOwnedReservation, reserveDailyUsage, type DailyReservation } from './daily-usage.ts';
import { countRequestInput } from './request-token-count.ts';
import { freezeReportedModel } from './model-identity.ts';
import { workersAiBinding, runWorkersAi } from './workers-ai.ts';

/**
 * One read of this document's own records on the Workflow path (DECISIONS 135): retried on a documented transient error
 * within the bound (readD1). Past the bound it is this document's typed storage failure; any other error is unchanged.
 */
const documentRead = <T = Record<string, unknown>>(statement: D1PreparedStatement): Promise<T | null> => readD1<T>(statement,
  undefined, cause => Object.assign(new ServerFailure('E_STORAGE_READ', 'blocker', serverCopy.storageReadUnconfirmed), { cause }));

/** The largest raw vendor body that is decoded and validated in memory; larger bodies are kept and refused. */
const RAW_VALIDATION_BYTES = 8 * 1024 * 1024;

export async function guard(env: Env, store: Store, runId: string): Promise<void> {
  let frozenCount: number | undefined, remainingProgress: number | undefined, nonProgress = 0;
  const unverifiable = () => new ServerFailure('E_RUNTIME_WAIT_STATE', 'blocker', 'The saved runtime waiting deadline could not be reconciled.');
  // A productive settlement is not a failed attempt. Each expired document can leave the pending set once; use the
  // run's frozen membership as a finite bound on productive passes, with a final full control check after the last one.
  // A lease-only revision race leaves the wait pending and consumes the unchanged three-attempt non-progress bound.
  for (;;) {
  // The kill switch, the run row and the storage brake's trip in one read; checked in the same order as before:
  // controls, kill switch, run, and the trip only after the model, spending and unknown-spend stops.
  const { kill, run: current, storageTripped } = await store.guardSnapshot(runId);
  if (kill === null) throw new ServerFailure('E_STORAGE_D1', 'blocker', 'Run controls are missing.');
  if (kill)
    throw new ServerFailure('E_KILL_SWITCH', 'blocker', 'The kill switch is set.');
  if (!current) throw new ServerFailure('E_RUN_NOT_FOUND', 'request', 'The run does not exist.', 404);
  const run = current;
  if (run.status !== 'running')
    throw new ServerFailure('E_RUN_STOPPED', 'blocker', 'This run is not running.');
  if (String(env.MODEL_CALLS_ENABLED) !== 'true')
    throw new ServerFailure('E_MODEL_CALLS_DISABLED', 'blocker', 'Model calls are disabled.');
  // Also runs at Workflow entry and each model boundary, so a queued instance cannot execute a newer build.
  await requireBakeoffExecution(env, store, run);
  // Spend and unknown-call counts come from the run row already loaded (maintained in the same D1 batch as every
  // vendor_calls insert), not from a scan of the run's calls. The numbers, the rules and the halts are identical to the
  // scan, so this is not a policy version change; the scan remains as `store.scanSpend` for reconciliation.
  const frozen = JSON.parse(run.pack_json ?? '{}');
  const admission = checkSpendAdmission(
    frozen.settings?.unknownSpendPolicy,
    readRunBudget(JSON.parse(run.budget_json)),
    spendFromRow(run),
    unknownFromRow(run)
  );
  if (admission.reason === 'unknown_spend') throw new ServerFailure('E_SPEND_UNACCOUNTED', 'blocker', serverCopy.spendUnaccounted);
  if (admission.reason === 'limit_reached') throw new ServerFailure('E_LIVE_BUDGET', 'blocker', serverCopy.liveBudget(admission.reached));
  // DECISIONS 140 (a): a recorded trip holds at run level even when its stop was lost. Every caller halts on this blocker.
  if (storageTripped) throw storageCircuitFailure();
  try { assertRuntimeDeadline(run); return; }
  catch (error) {
    if (!(error instanceof ServerFailure) || error.code !== 'E_RUNTIME_WAIT_EXPIRED') throw error;
    if (frozenCount === undefined) {
      if (!Number.isSafeInteger(run.expected_count) || run.expected_count <= 0) throw unverifiable();
      frozenCount = run.expected_count; remainingProgress = frozenCount;
    }
    if (run.expected_count !== frozenCount || remainingProgress === 0) throw unverifiable();
    const changed = await enforceRuntimeDeadline(store, runId);
    const settled = await store.run(runId);
    // Preserve the existing completion case: entry/dispatch callers read their durable document outcome before work.
    if (settled.status === 'complete') return;
    if (settled.status !== 'running') continue; // The next full control check reports the actual stop.
    let expired = false;
    try { assertRuntimeDeadline(settled); }
    catch (issue) {
      if (!(issue instanceof ServerFailure) || issue.code !== 'E_RUNTIME_WAIT_EXPIRED') throw issue;
      expired = true;
    }
    if (changed || !expired) {
      remainingProgress = remainingProgress! - 1; nonProgress = 0;
      continue; // All controls run again; a cleared deadline remains admissible even after the last productive pass.
    }
    if (++nonProgress === D1_WRITE_ATTEMPTS) throw unverifiable();
    await d1WriteBackoff(nonProgress);
  }
  }
}

/**
 * While calls already in flight hold a daily pool, a request waits durably (top-level Workflow sleeps) and asks again.
 * The interval and the bound are wall time: the bound is three times the ten-minute vendor timeout, so capacity held by
 * genuine calls is always released first; only capacity that never settles reaches it. 30 min / 15 s keeps one waiting
 * request to at most 240 counted Workflow steps (sleeps are not counted).
 */
export const DAILY_CONTENTION = Object.freeze({ intervalMs: 15_000, boundMs: 30 * 60_000 });
/**
 * The waits before the same request is sent again (core/vendors/transport.ts `transientDelay`): a 429 waits 1 s, then
 * 2 s; a server error or a lost connection waits 20 s, then 30 s (owner decision of 8 October 2026, DECISIONS 142).
 */
export const VENDOR_RETRY_DELAYS = Object.freeze({ baseDelayMs: 1000, serverErrorBaseDelayMs: 20_000, maxBackoffMs: 30_000 });
interface OwnedReservation { attemptId: string; ownerNonce: string }
type SavedReservation = { at: number } & DailyReservation;

export class Runner {
  readonly env: Env;
  readonly store: Store;
  readonly run: RunRow;
  readonly fingerprint: string;
  readonly step: WorkflowStep;
  private runtimeFrame: RuntimeFrame | null = null;
  /** A model call's transport retry waits (vendor() below); tests shorten them. */
  vendorRetry: { baseDelayMs: number; serverErrorBaseDelayMs: number; maxBackoffMs: number } = VENDOR_RETRY_DELAYS;
  /** The input count's retry waits: the same as a model call's; tests shorten them. */
  countRetry: { baseDelayMs: number; serverErrorBaseDelayMs: number; maxBackoffMs: number } = VENDOR_RETRY_DELAYS;
  /** Production uses DAILY_CONTENTION; tests shorten the real-time interval and bound. */
  dailyContention: { intervalMs: number; boundMs: number } = DAILY_CONTENTION;

  /** Vendor attempts whose receipt this invocation itself confirmed, with their recorded cost. */
  private readonly confirmedCalls = new Map<string, { costNano: string | null }>();
  /** Vendor attempts this invocation sent whose receipt it has not yet confirmed (the money rule of DECISIONS 135). */
  private readonly unsettled = new Set<string>();
  /**
   * Set when a stage's guard or action raised a run-level stop: a blocker that is neither this document's own storage
   * outcome nor an unconfirmable charge. If that stage's failure record then cannot be confirmed (E_CHECKPOINT_FAIL), the
   * run still stops: a lost record never turns a run-level stop into a set-aside (DECISIONS 135).
   */
  private stageStopped = false;

  /** `store` lets the Workflow share one Store, so artifacts this invocation wrote are not read back from R2. */
  constructor(env: Env, run: RunRow, fingerprint: string, step: WorkflowStep, store?: Store) {
    this.env = env;
    this.store = store ?? new Store(env);
    this.run = run;
    this.fingerprint = fingerprint;
    this.step = step;
  }

  /**
   * DECISIONS 135, containment. A storage outcome of THIS document that stayed unconfirmed past the bounded retries sets
   * the document aside (kind 'document': could_not_process with its storage code) instead of halting the run. The money
   * rule is unchanged: while any vendor attempt of this document has no confirmed receipt, only a run whose unknown-spend
   * policy isolates an unknown charge may set it aside; any other run halts exactly as before, and so does an
   * unreadable check. Run-level failures and every other code are returned unchanged.
   */
  async containStorageFailure(issue: ServerFailure): Promise<ServerFailure> {
    if (issue.kind !== 'blocker') return issue;
    // E_CHECKPOINT_FAIL wraps the stage's own failure: a run-level stop stays a stop.
    if (issue.code === 'E_CHECKPOINT_FAIL' && this.stageStopped) return issue;
    const charge = CHARGE_STORAGE_CODES.has(issue.code);
    if (!charge && !DOCUMENT_STORAGE_CODES.has(issue.code)) return issue;
    if (!unknownChargeIsolated(this.run)) {
      if (charge || this.unsettled.size > 0) return issue;
      if (await unaccountedAttempts(this.env.DB, this.run.id, this.fingerprint) !== 0) return issue;
    }
    // DECISIONS 144: exhausted runtime interruptions are set aside on the same rule, with their own plain reason.
    const contained = new ServerFailure(issue.code, 'document', issue.code === 'E_RUNTIME_WAIT_LIMIT'
      ? serverCopy.documentRuntimeInterrupted(RUNTIME_INTERRUPTION_LIMIT) : issue.code === 'E_RUNTIME_WAIT_EXPIRED'
      ? serverCopy.documentRuntimeExpired(RUNTIME_WAIT_MS / 60_000) : issue.code === 'E_RUNTIME_TERMINAL'
      ? serverCopy.documentRuntimeTerminal : serverCopy.documentStorageUnconfirmed);
    contained.cause = issue;
    return contained;
  }

  async executionGuard(): Promise<void> {
    await guard(this.env, this.store, this.run.id);
  }

  /** Inside a stage: remembers a run-level stop (see `stageStopped`); every error is rethrown unchanged. */
  private async noteStageStop<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof SupersededRuntimeEntry || error instanceof DeferredRuntimeInterruption)) {
        const issue = failure(error);
        if (issue.kind === 'blocker' && !DOCUMENT_STORAGE_CODES.has(issue.code) && !CHARGE_STORAGE_CODES.has(issue.code)) this.stageStopped = true;
      }
      throw error;
    }
  }

  async enterNative(instanceId: string): Promise<RuntimeFrame> {
    this.runtimeFrame = await claimNativeRuntimeEntry(this.store, this.run.id, this.fingerprint, instanceId,
      () => this.executionGuard());
    return this.runtimeFrame;
  }

  private async nativeReplayCheckpoint(name: string): Promise<string | null> {
    await this.executionGuard();
    const row = await documentRead<{
      status: string; artifact_key: string | null; error_code: string | null;
      error_kind: string | null; error_detail: string | null; artifact_run_id: string | null;
      artifact_fingerprint: string | null; artifact_state: string | null; artifact_deleted_at: string | null;
    }>(this.env.DB.prepare(
      'SELECT c.status,c.artifact_key,c.error_code,c.error_kind,c.error_detail,a.run_id AS artifact_run_id,a.fingerprint AS artifact_fingerprint,a.state AS artifact_state,a.deleted_at AS artifact_deleted_at FROM checkpoints c LEFT JOIN artifacts a ON a.key=c.artifact_key WHERE c.run_id=? AND c.fingerprint=? AND c.name=?'
    ).bind(this.run.id, this.fingerprint, name));
    if (!row) return null;
    if (row.status === 'complete' && typeof row.artifact_key === 'string' && row.artifact_key.trim() &&
        row.artifact_run_id === this.run.id && row.artifact_fingerprint === this.fingerprint &&
        row.artifact_state === 'complete' && row.artifact_deleted_at === null) return row.artifact_key;
    if (row.status === 'failed' && row.error_code && row.error_detail &&
        (row.error_kind === 'blocker' || row.error_kind === 'document' || row.error_kind === 'request'))
      throw new ServerFailure(row.error_code, row.error_kind, row.error_detail);
    throw new ServerFailure('E_STEP_UNCERTAIN', 'blocker', serverCopy.checkpointUncertain);
  }

  async reference(name: string, action: () => Promise<string | StageResult>): Promise<string> {
    const replayFrame = this.runtimeFrame && this.runtimeFrame.entrySequence > 1 ? this.runtimeFrame : null;
    // A native re-entry can replay an engine failure for a stage that D1 already completed.
    // Read our authoritative record before consulting that cache; never re-execute an uncertain stage.
    if (replayFrame) {
      const recordedKey = await this.nativeReplayCheckpoint(name);
      if (recordedKey !== null) {
        await this.store.event(this.run.id, this.fingerprint, name, 'checkpoint_reused', {
          source: 'd1', entrySequence: replayFrame.entrySequence, policy: 'complete-checkpoint-replay-v1'
        });
        return recordedKey;
      }
    }
    const key = await workflowReference(name, {
      execute: callback => this.step.do(
        name,
        { retries: { limit: 0, delay: '1 second', backoff: 'constant' }, timeout: '15 minutes' },
        callback
      ),
      checkpoint: () => checkpoint(
        this.store.checkpoints(this.run.id, this.fingerprint),
        () => this.noteStageStop(() => this.executionGuard()),
        name,
        () => this.noteStageStop(action)
      ),
      readCompleted: async () => {
        const row = await documentRead<{ status: string; artifact_key: string | null }>(this.env.DB
          .prepare('SELECT status,artifact_key FROM checkpoints WHERE run_id=? AND fingerprint=? AND name=?')
          .bind(this.run.id, this.fingerprint, name));
        return row?.status === 'complete' ? row.artifact_key : null;
      },
      recovered: async (source, runtimeDiagnostic) => {
        // The recognised interruption that lost the acknowledgement is recorded as evidence (DECISIONS 144); an
        // unrecognised error is not copied. The completed result stands either way, and this entry continues: a
        // deferral needs an absent stage, and the engine replays a broken instance on its own (r07, 7 October 2026).
        await this.store.event(this.run.id, this.fingerprint, name, 'workflow_ack_recovered', {
          source,
          policy: 'completed-checkpoint-ack-v2',
          ...(runtimeDiagnostic ? { runtimeDiagnostic } : {})
        });
      },
      ...(this.runtimeFrame ? { deferUnstarted: (original: Error) =>
        deferUnenteredRuntime(this.store, this.runtimeFrame!, name, original, () => this.executionGuard()) } : {}),
    });
    // A successful SDK cache reply without callback entry is not proof that our stage completed.
    // Only validate success here: thrown errors keep their existing classification and never become a result.
    if (replayFrame) {
      const recordedKey = await this.nativeReplayCheckpoint(name);
      if (recordedKey === null || recordedKey !== key)
        throw new ServerFailure('E_STEP_UNCERTAIN', 'blocker', serverCopy.checkpointUncertain);
    }
    return key;
  }

  /**
   * One stage: its claimed checkpoint, its action, its stored result and ONE completion event. The stage's start is the
   * checkpoint's `started_at` (no separate 'started' event row). A non-text result's single complete ledger row and the
   * completion event commit in the same D1 batch as the checkpoint finish; text keeps its register-first ledger path.
   */
  async stage<T>(name: string, action: () => Promise<T>, containsText = false): Promise<string> {
    return this.reference(name, async (): Promise<StageResult> => {
      const started = Date.now();
      const result = await action();
      if (containsText) {
        const key = await this.store.put(this.run.id, this.fingerprint, name, result, true);
        return { key, completion: { event: this.store.eventRecord(this.run.id, this.fingerprint, name, 'completed', { key }, Date.now() - started) } };
      }
      const artifact = await this.store.putObject(this.run.id, this.fingerprint, name, result);
      return { key: artifact.key, completion: { artifact,
        event: this.store.eventRecord(this.run.id, this.fingerprint, name, 'completed', { key: artifact.key }, Date.now() - started) } };
    });
  }

  /** Persist a relative wait once; replays never extend its absolute deadline. */
  async wait(name: string, milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new ServerFailure(
      'E_WORKFLOW_WAIT_STATE',
      'blocker',
      'The workflow wait duration is invalid.'
    );
    await this.waitDeadline(name, () => Date.now() + milliseconds);
  }

  async waitUntil(name: string, until: number): Promise<void> {
    if (!Number.isSafeInteger(until) || until < 0) throw new ServerFailure(
      'E_WORKFLOW_WAIT_STATE',
      'blocker',
      'The workflow wait deadline is invalid.'
    );
    await this.waitDeadline(name, () => until);
  }

  private async waitDeadline(name: string, createDeadline: () => number): Promise<void> {
    // Deadline creation and artifact reads are outside timer-error reconciliation.
    // Any callback/storage failure must propagate rather than look like an elapsed wait.
    const make = async () => ({ until: createDeadline(), policy: 'absolute-wait-v1' });
    const key = await this.stage(name + '-deadline', make);
    const saved = await this.store.json<{ until: number; policy: string }>(key);
    if (saved.policy !== 'absolute-wait-v1') throw new ServerFailure(
      'E_WORKFLOW_WAIT_STATE',
      'blocker',
      'The saved workflow wait policy is invalid.'
    );
    await workflowWait(name, saved.until, {
      now: Date.now,
      guard: () => this.executionGuard(),
      sleepUntil: (stepName, until) => this.step.sleepUntil(stepName, until),
      ...(this.runtimeFrame ? { deferUnstarted: (original: Error) =>
        deferUnenteredRuntime(this.store, this.runtimeFrame!, name, original, () => this.executionGuard()) } : {}),
      recovered: async until => {
        await this.store.event(this.run.id, this.fingerprint, name, 'workflow_wait_ack_recovered', {
          until,
          policy: 'absolute-wait-v1'
        });
      },
    });
  }

  async admission(role: VendorRole, nextAttempt: number, group?: VendorGroup): Promise<void> {
    const names = vendorNames(role, group);
    // Existing checkpoints represent dispatched/completed/uncertain work and are never sent again.
    const prior = await documentRead(this.env.DB
      .prepare('SELECT status FROM checkpoints WHERE run_id=? AND fingerprint=? AND name=?')
      .bind(this.run.id, this.fingerprint, names.http(nextAttempt)));
    if (prior) return;
    const scope = providerScope(role);
    await awaitProviderAdmission({
      now: Date.now,
      guard: () => this.executionGuard(),
      readDeadline: () => readProviderCooldown(this.env.DB, scope),
      waitUntil: async until => {
        const name = names.label + '-admission-' + nextAttempt + '-' + until;
        await this.stage(name, async () => {
          await this.store.event(this.run.id, this.fingerprint, 'provider_cooldown', 'waiting', {
            scope,
            until
          });
          return { scope, until };
        });
        // Absolute timestamp and stable name prevent replay from adding another relative delay.
        // This is a top-level Workflow operation, outside both the plan and HTTP step.do callbacks.
        await this.waitUntil(name + '-wait', until);
      }
    });
  }

  /** One terminal circuit outcome per document/vendor. Keep role-named checkpoints compatible with frozen replays. */
  private async recordCircuitOutcome(role: VendorRole, exhausted: boolean): Promise<number> {
    const key = await this.stage(role + '-circuit-outcome', async () => ({
      failures: await persistCircuitOutcome(this.env.DB, { runId: this.run.id, fingerprint: this.fingerprint, role, exhausted })
    }));
    return (await this.store.json<{ failures: number }>(key)).failures;
  }

  /**
   * DESIGN §6 (independent review F6): a document whose reader request is over the reader's context fails here, before
   * anything is reserved or sent for it. OpenAI's exact count is the same checkpointed count the reader call reuses
   * later, so it is requested once; Workers AI and DeepSeek use the request's UTF-8 byte bound. An OpenAI reader without
   * usage limits sends no count request, so it is not bounded here and nothing is estimated; the vendor's own context
   * refusal (transport) stays the backstop.
   */
  async requireReaderContext(request: FrozenVendorRequest, pack: ProjectPack): Promise<void> {
    const vendor = requestVendor(request.role, request.modelPolicy);
    if (vendor === 'openai' && !pack.settings.usageLimits) return;
    const bound = readerContextBound(request, vendor === 'openai' ? await countRequestInput(this, request) : null);
    if (bound !== null && bound > pack.limits.readerContextTokens)
      throw new ServerFailure('E_READER_CONTEXT', 'document', 'The full text exceeds the reader context limit.');
  }

  /** Recovery succeeded, but another document stage failed before the reader could run. */
  async finishRecoveryWithoutReader(): Promise<void> {
    await this.recordCircuitOutcome('recovery', false);
  }

  /**
   * The attempt's own daily reservation, made in its own checkpoint just before the HTTP checkpoint, so that a pool held
   * by calls in flight is a durable top-level wait rather than a stop. Exhaustion of settled usage (unknown usage is charged
   * at its reservation), unknown usage without a reservation, excess usage and storage failures still stop the run.
   * Returns null when the HTTP checkpoint already exists: its own record
   * decides (it never sends again).
   */
  private async holdDailyReservation(label: string, http: string, attempt: number, attemptId: string, model: string,
    reservation: NonNullable<ReturnType<typeof reservationForRequest>>): Promise<OwnedReservation | null> {
    if (await this.checkpointExists(http)) return null;
    const { intervalMs, boundMs } = this.dailyContention;
    let firstBusyAt: number | null = null;
    for (let round = 1; ; round++) {
      const key = await this.stage(`${label}-daily-${attempt}-${round}`, async (): Promise<SavedReservation> => {
        const at = Date.now();
        const result = await reserveDailyUsage(this.env.DB, { ...reservation, attemptId, runId: this.run.id, modelId: model,
          at: new Date(at).toISOString() });
        if (result.state === 'busy') await this.store.event(this.run.id, this.fingerprint, label, 'daily_usage_waiting',
          { pool: reservation.pool.id, usedUnits: result.usedUnits, reservedUnits: result.reservedUnits, requestUnits: reservation.reservedUnits });
        return { ...result, at };
      });
      const saved = await this.store.json<SavedReservation>(key);
      if (saved.state === 'created') return { attemptId, ownerNonce: saved.ownerNonce };
      if (saved.state !== 'busy' || !Number.isSafeInteger(saved.at))
        throw new ServerFailure('E_DAILY_USAGE_UNCERTAIN', 'blocker', usageCopy.uncertain);
      // Both instants are recorded in the stages, so a replay reaches the same decision.
      firstBusyAt ??= saved.at;
      if (saved.at - firstBusyAt >= boundMs)
        throw new ServerFailure('E_DAILY_USAGE_BUSY', 'blocker', usageCopy.busy(Math.round(boundMs / 60_000)));
      await this.wait(`${label}-daily-${attempt}-wait-${round}`, intervalMs);
    }
  }

  /** Whether this document's checkpoint exists; a read on the bounded rule (DECISIONS 135) whose last error still stops the run. */
  private async checkpointExists(name: string): Promise<boolean> {
    return await readD1(this.env.DB.prepare('SELECT 1 AS found FROM checkpoints WHERE run_id=? AND fingerprint=? AND name=?')
      .bind(this.run.id, this.fingerprint, name)) !== null;
  }

  /**
   * Releases this invocation's own reservation that provably sent nothing, by an immutable receipt only its owner records.
   * Given `http`, only while that HTTP checkpoint was never claimed. A failure to record it is attached to `error`, never
   * replaces it; the hold then keeps counting as in flight.
   */
  private async releaseUnsentReservation(owned: OwnedReservation, error: unknown, http?: string): Promise<void> {
    try {
      if (http !== undefined && await this.checkpointExists(http)) return;
      await cancelUnsentDailyReservation(this.env.DB, { ...owned, at: new Date().toISOString(),
        reason: error instanceof ServerFailure ? error.code : 'E_EXECUTION_GUARD' });
    } catch (recordError) {
      if (error instanceof Error) error.cause = new AggregateError([recordError], 'The unsent reservation could not be released.');
    }
  }

  /**
   * One vendor request: bounded retries of the same bytes, every attempt recorded before it is read. `group` names
   * this request among the several a document sends under `confidence-grouped-nouls-v1`: HTTP checkpoints, attempt
   * ids and per-request artifacts carry the group, so requests cannot replay each other; the circuit remains per document. The vendor_call event
   * records groupIndex/groupCount (the document's text is billed once per request).
   */
  async vendor<T>(
    request: FrozenVendorRequest,
    pack: ProjectPack,
    decode: (raw: unknown) => T,
    group?: VendorGroup
  ): Promise<string> {
    let index = 0, activeId = '', sleepIndex = 0, fetchFatal: unknown;
    const role = request.role;
    const names = vendorNames(role, group);
    // The vendor follows the pinned model's family (DECISIONS 136); recovery and Jev keep their vendors.
    const vendor: RequestVendor = requestVendor(role, request.modelPolicy);
    // The binding is the Workers AI credential: without it nothing is counted, reserved or sent.
    if (vendor === 'cloudflare' && !workersAiBinding(this.env))
      throw new ValidationFailure('E_VENDOR_KEY', 'blocker', 'Vendor credentials are missing.');
    // Only OpenAI documents an input-count endpoint; the other readers reserve their byte bound (input-token-count.ts).
    const inputTokens = pack.settings.usageLimits && role !== 'confidence' && vendor === 'openai' ? await countRequestInput(this, request) : null;
    const reservation = reservationForRequest(pack, request, inputTokens);
    let providerRefusal = false;
    const deferredOutcome = { exhausted: null as boolean | null };
    const consecutiveFailureLimit = 3;
    // isolate-unlimited-v1, not-processed-zero-v2 and not-processed-zero-v3 isolate an unknown charge on an unlimited run.
    const isolateUnknown =
      isolatesUnknownSpend(pack.settings.unknownSpendPolicy) &&
      readRunBudget(JSON.parse(this.run.budget_json)).mode === 'unlimited';
    // The site-wide provider cooldowns are OpenAI's and TypeSafe's. Workers AI and DeepSeek document no retry-after;
    // a hint they do send is still honoured as this request's own minimum delay (transport retryDelay).
    const cooldown = vendor === 'openai' || vendor === 'typesafe';
    const deps: TransportDependencies = {
      ...(cooldown ? {
        awaitAdmission: () => this.admission(role, index + 1, group),
        observeRetryAfter: (attempt: RawAttempt) => observeProviderCooldown(
          this.env.DB,
          role,
          attempt.attemptId,
          attempt.retryAfter!
        )
      } : {}),
      guard: async () => {
        await this.executionGuard();
        // Returned model identity is checked by the ordinary transport before this post-response guard.
        // Keep its explicit auth/model refusal ahead of the daily unknown-usage blocker.
        if (reservation && !providerRefusal) await assertDailyUsage(this.env.DB, reservation.pool, new Date().toISOString());
      },
      // One credential per vendor; none is ever sent to another vendor's host.
      readSecret: async (requested, requestedVendor) => requested === 'confidence'
        ? this.env.JEV_API_KEY.get()
        : requestedVendor === 'deepseek'
          ? (this.env.DEEPSEEK_API_KEY ? this.env.DEEPSEEK_API_KEY.get() : null)
          : this.env.OPENAI_API_KEY.get(),
      now: Date.now,
      attemptId: () => activeId = `${this.run.id}-${this.fingerprint}-${role}-${names.attempt(++index)}`,
      sleep: async milliseconds => {
        // Sleep is a top-level durable Workflow operation, never nested inside step.do.
        await this.wait(`${names.label}-retry-wait-${++sleepIndex}`, milliseconds);
      },
      fetch: async (url, init) => {
        let knownNetworkFailure = false;
        try {
          // Top level, before the HTTP checkpoint: contention waits here; nothing below waits for capacity.
          const owned = reservation
            ? await this.holdDailyReservation(names.label, names.http(index), index, activeId, request.model, reservation) : null;
          const http = this.reference(names.http(index), async () => {
            const started = Date.now();
            let response: Response | null = null, raw: string | null = null, bindingRequestId: string | null = null;
            let bindingGatewayLogId: string | null = null;
            let responseKey: string | null = null, rawOverflow = false;
            if (reservation) {
              if (!owned || owned.attemptId !== activeId) throw new ServerFailure('E_DAILY_USAGE_UNCERTAIN', 'blocker', usageCopy.uncertain);
              await confirmOwnedReservation(this.env.DB, owned);
              try { await this.executionGuard(); }
              catch (error) {
                // This callback has not entered fetch.
                await this.releaseUnsentReservation(owned, error);
                throw error;
              }
            }
            this.unsettled.add(activeId);
            try {
              const options = { ...init, signal: AbortSignal.timeout(10 * 60 * 1000) };
              if (vendor === 'cloudflare') {
                // The Workers AI binding with its unparsed reply; persisted below exactly like an HTTP body.
                const sent = await runWorkersAi(this.env, request.model, request.body, options.signal);
                response = sent.response; bindingRequestId = sent.bindingRequestId; bindingGatewayLogId = sent.bindingGatewayLogId;
              } else response = outbound.vendors === 'fake' && role === 'confidence'
                ? await outbound.fetch(url, options, { confidenceTypeIds: Object.freeze(pack.typeFile.types.map(type => type.id)) })
                : await outbound.fetch(url, options);
            }
            catch {
              response = null;
              raw = null;
              /* Record a network failure without persisting a credential-bearing exception. */
            }
            let rawBytes: ArtifactRegistration | null = null;
            if (response?.body) {
              const rawBytesKey = `${this.run.id}/${this.fingerprint}/raw-bytes/${activeId}`;
              const declared = Number(response.headers.get('content-length') ?? NaN);
              if (Number.isSafeInteger(declared) && declared > RAW_VALIDATION_BYTES) {
                // A declared oversize body is streamed to storage unread, as before (register-first ledger row).
                responseKey = await this.store.putRawStream(this.run.id, this.fingerprint, response.body, rawBytesKey);
                const key = responseKey;
                const stored = await readR2(() => this.env.ARTIFACTS.head(key));
                if (!stored) throw new ServerFailure(
                  'E_ARTIFACT_MISSING',
                  'blocker',
                  'The persisted raw vendor response is missing.'
                );
                rawOverflow = stored.size > RAW_VALIDATION_BYTES;
              } else {
                // The exact received bytes are stored before anything parses them; their ledger row commits with the
                // call receipt below. Decoding is the same UTF-8 decoding an R2 text read applies.
                const bytes = new Uint8Array(await response.arrayBuffer());
                rawBytes = await this.store.putObjectBytes(this.run.id, this.fingerprint, 'vendor_raw_bytes', bytes, rawBytesKey);
                responseKey = rawBytes.key;
                rawOverflow = bytes.byteLength > RAW_VALIDATION_BYTES;
                if (!rawOverflow) raw = new TextDecoder().decode(bytes);
              }
            }
            const latencyMs = Date.now() - started;
            const envelope = {
              networkFailure: response === null,
              status: response?.status ?? null,
              headers: response ? [...response.headers.entries()] : [],
              raw,
              responseKey,
              rawOverflow,
              latencyMs,
              // Workers AI only: the binding's own record of the request (env.AI.lastRequestId), when it sets one, and
              // its AI Gateway log id, which stays null because no gateway option is ever passed.
              ...(vendor === 'cloudflare' ? { bindingRequestId, bindingGatewayLogId } : {})
            };
            const rawEnvelope = await this.store.putObject(
              this.run.id,
              this.fingerprint,
              'raw_response',
              envelope,
              `${this.run.id}/${this.fingerprint}/raw/${activeId}.json`
            );
            const rawKey = rawEnvelope.key;
            // Persistence precedes even the accounting parse. Recording completes in the same guarded step as HTTP.
            let parsed: Record<string, unknown> | null = null;
            try {
              const value: unknown = raw === null ? null : JSON.parse(raw);
              if (value && typeof value === 'object' && !Array.isArray(value))
                parsed = value as Record<string, unknown>;
            } catch {
              /* Invalid JSON remains unmodified; the validator handles it. */
            }
            const hasUsage = parsed !== null && Object.hasOwn(parsed, 'usage');
            const usage = hasUsage ? parsed!.usage : null;
            let cost: string | null = null;
            if (response && (response.status >= 200 && response.status < 300 || hasUsage)) {
              try {
                if (
                  response.status >= 200 && response.status < 300 ||
                  parsed && Object.hasOwn(parsed, 'model')
                ) verifyModelPolicy(request.modelPolicy, parsed?.model, role);
                // The run's recorded cache policy: frozen packs without one keep the no-cache accounting. Workers AI
                // reports chat-completion usage, priced at its one Neuron input rate (DECISIONS 136).
                cost = vendor === 'cloudflare'
                  ? chatUsageCost(usage, pricingFor(pack)[role])
                  : actualUsageCost(usage, pricingFor(pack)[role], usageCachePolicy(pack.settings, role));
              }
              catch (error) {
                await this.store.event(this.run.id, this.fingerprint, role, 'accounting_failed', {
                  code: error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : 'E_VENDOR_USAGE'
                });
              }
            }
            // not-processed-zero-v2 (DECISIONS 90) applies only to what the rules above would have left unknown: an
            // answer without usage whose status says nothing was processed (429; 5xx with an empty body) is recorded at
            // zero, so it is not an unknown charge and the transport's retry runs. Returned usage was priced above and is
            // never discarded. `raw` is also null for an oversize body (rawOverflow), which is not empty.
            // not-processed-zero-v3 (DECISIONS 152, evening addendum) adds TypeSafe's refusal of a confidence request as
            // too large, read from the retained body just stored; the transport makes it this document's own failure.
            // Under v2 and earlier it stays an unknown charge. The policy is the run's frozen pack's, as for v2.
            const bodyEmpty = response !== null && !rawOverflow && emptyBody(raw);
            const tooLarge = !rawOverflow && confidenceTooLargeRefusal(vendor, role, response?.status ?? null, raw);
            const notProcessed = !rawOverflow && cost === null && !hasUsage &&
              notProcessedAttempt(pack.settings.unknownSpendPolicy, response?.status ?? null, bodyEmpty, tooLarge);
            if (notProcessed) cost = '0';
            // One atomic batch: the attempt's artifact rows, the call row, the run's spend counters and the
            // vendor_call event (see persistVendorCall).
            const callEvent = this.store.eventRecord(
              this.run.id,
              this.fingerprint,
              role,
              'vendor_call',
              {
                attemptId: activeId,
                status: response?.status ?? null,
                ...(group ? { groupIndex: group.index, groupCount: group.count } : {}),
                ...(notProcessed ? { notProcessed: true } : {})
              },
              latencyMs
            );
            await this.store.recordVendorCall({
              attemptId: activeId,
              runId: this.run.id,
              fingerprint: this.fingerprint,
              role,
              modelRequested: request.model,
              modelReturned: typeof parsed?.model === 'string' ? parsed.model : null,
              status: response?.status ?? null,
              latencyMs,
              requestId: response?.headers.get('x-request-id') ??
                response?.headers.get('request-id') ??
                response?.headers.get('cf-ai-req-id') ??
                bindingRequestId ??
                null,
              usageJson: hasUsage ? JSON.stringify(usage) : null,
              costNano: cost,
              rawKey
            }, { artifacts: rawBytes ? [rawBytes, rawEnvelope] : [rawEnvelope], event: callEvent });
            this.confirmedCalls.set(activeId, { costNano: cost });
            this.unsettled.delete(activeId);
            // DECISIONS 136: an undated reader's first reported model string is frozen for the run; any other string,
            // or a successful reply that reports none, halts it. Recorded and settled above before this check. An
            // OpenAI family requested by name (DECISIONS 155) is the same, except that a string outside its family is
            // drift and halts here, before it could be frozen.
            if (request.modelPolicy.policy === 'owner_approved_undated') {
              const reported = typeof parsed?.model === 'string' ? parsed.model : null;
              // A locked option (owner decision of 7 October 2026): every reply must report exactly the locked name.
              const locked = role === 'reader' ? pack.readerModels?.options
                .find(option => option.id === pack.selectedReaderModel && option.pin.id === request.model)?.expectedModel : undefined;
              if (locked !== undefined && reported !== null && reported.length > 0 && reported !== locked)
                throw new ServerFailure('E_MODEL_PROVIDER_CHANGED', 'blocker', usageCopy.providerChanged(locked, reported));
              if (reported !== null && reported.length > 0) verifyModelPolicy(request.modelPolicy, reported, role);
              if (reported !== null && reported.length > 0)
                await freezeReportedModel(this.env.DB, { runId: this.run.id, role, modelRequested: request.model,
                  modelReported: reported, attemptId: activeId, at: new Date().toISOString() });
              else if (response && response.status >= 200 && response.status < 300)
                throw new ServerFailure('E_MODEL_IDENTITY_MISSING', 'blocker', usageCopy.identityMissing);
            }
            return rawKey;
          });
          let key: string;
          try { key = await http; }
          catch (error) {
            // A deferred or superseded native entry is entered again: its reservation checkpoint replays the same nonce and
            // the HTTP checkpoint confirms and sends. Until then the hold correctly counts as in flight.
            if (owned && !(error instanceof DeferredRuntimeInterruption || error instanceof SupersededRuntimeEntry))
              await this.releaseUnsentReservation(owned, error, names.http(index));
            throw error;
          }
          const envelope = await this.store.json<{
            networkFailure: boolean;
            status: number | null;
            headers: [string, string][];
            raw: string | null;
            rawOverflow?: boolean
          }>(key);
          if (envelope.rawOverflow) {
            // Raw bytes and the unknown-cost ledger row are durable. Only an explicitly isolating unlimited policy
            // makes this a document failure; kill/stopped controls remain authoritative after the response arrives.
            if (isolateUnknown) await this.executionGuard();
            throw new ServerFailure(
              'E_VENDOR_RESPONSE_MEMORY',
              isolateUnknown ? 'document' : 'blocker',
              'The complete raw response was saved, but it exceeds the safe validation envelope.'
            );
          }
          if (envelope.networkFailure) {
            knownNetworkFailure = true;
            throw new Error('Recorded network failure.');
          }
          if (reservation) {
            let error: { code?: unknown; param?: unknown } | null = null;
            try {
              const value: unknown = envelope.raw === null ? null : JSON.parse(envelope.raw);
              if (value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object') error = value.error;
            } catch { /* The ordinary transport retains ownership of malformed-response validation. */ }
            providerRefusal = envelope.status === 401 || envelope.status === 403 || envelope.status === 404 ||
              error?.code === 'model_not_found' || error?.param === 'model';
          }
          return new Response(envelope.raw, {
            status: envelope.status!,
            headers: envelope.headers
          });
        } catch (error) {
          if (!knownNetworkFailure) fetchFatal = error;
          throw error;
        }
      },
      persistRaw: async (_attempt: RawAttempt) => {
        if (!fetchFatal || fetchFatal instanceof ValidationFailure) { if (fetchFatal) throw fetchFatal; return; }
        // Every other failure of the recorded HTTP stage keeps its own code. An untyped error (a platform error from the
        // step engine, say) becomes E_INTERNAL with its message, never the transport's "raw response could not be
        // stored": that wording named a storage failure that had not happened (E_RAW_PERSIST halt, 6 October 2026).
        const typed = failure(fetchFatal);
        const issue = new ValidationFailure(typed.code, typed.kind === 'document' ? 'document' : 'blocker', typed.message);
        if (recordedWorkflowRuntimeDiagnostic(typed)) issue.cause = typed;
        throw issue;
      },
      ...(isolateUnknown ? {
        unknownCost: async (attemptId: string) => {
          // This invocation's own confirmed receipt is the same row; a replayed attempt is read from D1.
          const confirmed = this.confirmedCalls.get(attemptId);
          if (confirmed) return confirmed.costNano === null;
          const call = await documentRead<{ cost_nano: string | null }>(this.env.DB
            .prepare('SELECT cost_nano FROM vendor_calls WHERE attempt_id=? AND run_id=?')
            .bind(attemptId, this.run.id));
          if (!call)
            throw new ServerFailure('E_VENDOR_LOG', 'blocker', 'The vendor call was not recorded.');
          return call.cost_nano === null;
        }
      } : {}),
      logCall: async (_call: CallLog) => {
        if (this.confirmedCalls.has(activeId)) return;
        const logged = await documentRead(this.env.DB
          .prepare('SELECT attempt_id FROM vendor_calls WHERE attempt_id=?')
          .bind(activeId));
        if (!logged)
          throw new ServerFailure('E_VENDOR_LOG', 'blocker', 'The vendor call was not recorded.');
      },
      recordDocumentOutcome: async (requested: VendorRole, exhausted: boolean) => {
        // Neither a partial confidence group nor successful heading recovery is the document's vendor outcome.
        // Recovery and reader share the OpenAI circuit: the reader, or a terminal recovery failure, records it.
        if (group || role === 'recovery') { deferredOutcome.exhausted = exhausted; return 0; }
        return this.recordCircuitOutcome(requested, exhausted);
      },
    };
    let result: { value: T; attemptIds: string[] };
    try {
      result = await executeVendor(
        request,
        {
          transportAttempts: 3,
          schemaAttempts: role === 'reader' ? 2 : 1,
          ...this.vendorRetry,
          consecutiveFailureLimit
        },
        deps,
        decode
      );
    } catch (error) {
      // Transport still owns retry/exhaustion classification. A failed recovery terminates this document's OpenAI
      // work; a successful recovery defers its outcome until the reader or Workflow's pre-reader failure path.
      if ((group || role === 'recovery') && deferredOutcome.exhausted !== null) {
        const failures = await this.recordCircuitOutcome(role, deferredOutcome.exhausted);
        if (deferredOutcome.exhausted && failures >= consecutiveFailureLimit)
          throw new ValidationFailure('E_VENDOR_CIRCUIT', 'blocker', 'Consecutive documents exhausted vendor retries.');
      }
      throw error;
    }
    return this.stage(
      `${names.label}-validated`,
      async () => role === 'reader'
        ? {
          ...result,
          evidenceComparisonPolicy: readerEvidencePolicy(pack.settings.readerEvidencePolicy)
        }
        : result
    );
  }

  /**
   * The confidence check for one document under the pack's `confidenceQuestionPolicy`. Single request (the default,
   * and every frozen pack without the setting): exactly one vendor call, the `confidence-validated` artifact holding
   * `{value: ConfidenceOutput}`. Grouped: the requests of core/vendors/confidence-grouping.ts, one recorded vendor
   * call each (`confidence-g<i>-…`), then one `confidence-validated` artifact holding the merged output. Either way the
   * key returned is the document's `confidence_key` and any failed request fails the document before that artifact
   * exists.
   */
  async confidence(pack: ProjectPack, serializedDigest: string): Promise<string> {
    const pin = pack.pins.confidence, typeIds = pack.typeFile.types.map(type => type.id);
    let policy: ReturnType<typeof confidenceQuestionPolicy>;
    try { policy = confidenceQuestionPolicy(pack.settings.confidenceQuestionPolicy); }
    catch { throw new ServerFailure('E_PROJECT_CONFIG', 'blocker', 'Unknown confidence question policy.'); }
    if (policy === SINGLE_CONFIDENCE_POLICY) {
      const request = buildConfidenceRequest({ pin, typeFile: pack.typeFile, serializedDigest });
      return this.vendor(request, pack, raw => decodeConfidence(raw, pin, typeIds));
    }
    const groups = buildConfidenceRequests({ pin, typeFile: pack.typeFile, serializedDigest, budget: packQuestionBudget(pack) });
    const answers: { value: ConfidenceGroupAnswer; attemptIds: string[] }[] = [];
    for (const group of groups) {
      const key = await this.vendor(group.request, pack, raw => decodeConfidenceGroup(raw, pin, group), { index: group.index, count: group.count });
      answers.push(await this.store.json<{ value: ConfidenceGroupAnswer; attemptIds: string[] }>(key));
    }
    await this.recordCircuitOutcome('confidence', false);
    return this.stage('confidence-validated', async () => ({
      value: mergeConfidenceGroups(answers.map(answer => answer.value), { typeIds, requestCount: groups.length, pin: pin.id }),
      attemptIds: answers.flatMap(answer => answer.attemptIds),
      groupCount: groups.length
    }));
  }
}

/** Which of a document's several requests to one vendor this is (grouped confidence questions). */
export interface VendorGroup { readonly index: number; readonly count: number }

/**
 * The names a vendor request's records carry. Without a group they are today's (`confidence-http-1`,
 * `…-confidence-1`); with one, the group sits after `-http-` so `Store.pendingAccounting` still finds the attempt
 * (`confidence-http-g2-1` ↔ `…-confidence-g2-1`) and `documentPhase` still reads the stage from the prefix.
 */
function vendorNames(role: VendorRole, group?: VendorGroup): { label: string; attempt(n: number): string; http(n: number): string } {
  const label = group ? `${role}-g${group.index}` : role;
  const attempt = (n: number) => group ? `g${group.index}-${n}` : String(n);
  return { label, attempt, http: n => `${role}-http-${attempt(n)}` };
}
