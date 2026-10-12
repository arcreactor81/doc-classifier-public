/**
 * The SendController (SPEC §6.1; §4.7 "SendController.run"; walkthrough 3b steps 5–7): one per run. It uploads the
 * documents this browser read and the service does not hold yet, then hands the run over to sorting with the `/start`
 * loop. It runs only from the Start run click chain or a Continue sending click: never at boot, on a timer or after an
 * error (SPEC §0.1 rule 3). Logic only (SPEC §4.1 L2): it writes `RunStore.send`, reports to the caller's feedback
 * slot (`StepReport`) and shows its work in the TopBar through `ctx.begin(kind, '57 of 114')`.
 *
 * - One lock, `dc:send:<runId>`, covers the uploads and the hand-over, so they never overlap across tabs. Another tab
 *   holding it makes this call `elsewhere`; nothing is sent from here.
 * - Each document the service does not hold is uploaded once, in quote order, with the body rebuilt from its stored
 *   record exactly as at Confirm. A document the service already holds is never sent again. Nothing is retried: a
 *   dropped connection stops the loop (`dropped`) and a refused document stops it for good (`rejected`: Discard).
 * - Hand-over needs no local text: when every document is uploaded (the run is `uploading` with uploaded = total, or
 *   `running` with documents not yet handed over) Continue sending runs only the `/start` loop, in any browser signed
 *   in as the owner. Each `/start` is preceded by a fresh status read; a failed one is never repeated.
 * - The status reads here are the controller's own (fresh, full) and are applied to the RunStore like any other.
 */
import { signal } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { presentError, type UiErrorView } from '../../../core/ui/error-copy.ts';
import { UiShapeError, type RunStatus, type RunStatusResponse } from '../../../core/ui/wire.ts';
import {
  HANDOVER_GAP_MS, afterHandoverFailure, handedOver, handoverAgain, handoverEnd, handoverStep, sendEntry, uploadFailureKind,
  uploadQueue
} from '../../../core/ui/send-plan.ts';
import {
  DocumentRejectedError, ElsewhereError, NO_REPORT, NoLocalTextError, workTracker, type StepReport
} from '../../../core/ui/run-controls.ts';
import { prepareLocalRun } from '../../../core/local/preflight.ts';
import { getProject, startDispatch, uploadDocument } from '../api/endpoints.ts';
import { readLocalForRun, writeSendRejected, readDraftBakeoff, readBakeoffCreated } from '../persist/local-keys.ts';
import { bakeoffArm, prepareFrozenBakeoff } from '../../../core/ui/bakeoff-local.ts';
import { listLocalRecords, openLocalRunStore } from '../persist/local-records.ts';
import { sleep } from '../state/clock.ts';
import type { AppStore, RunStore } from '../state/types.ts';
import { LOCK_NAMES, withLock } from './locks.ts';
import { guardOff, guardOn, type GuardReason } from './unload-guard.ts';
import type { ControllerContext, ControllerRegistry } from './registry.ts';

export type SendOutcome =
  /** Every document is uploaded and handed over (or was decided at upload). */
  | { kind: 'done'; at: number }
  /** Another tab of this browser holds `dc:send:<runId>`; nothing was sent from here. */
  | { kind: 'elsewhere' }
  /** Documents are still to upload and this browser does not hold their text (SPEC §3b step 7). */
  | { kind: 'no-local-text'; remaining: number }
  /** The run is not sending (complete, stopped or closed) when Continue sending looked. */
  | { kind: 'not-live'; status: RunStatus }
  /** The run stopped or started closing during the hand-over; its Stopped card or closing state speaks. */
  | { kind: 'stopped'; status: RunStatus | null }
  | { kind: 'dropped'; error: UiErrorView }
  | { kind: 'rejected'; filename: string; error: UiErrorView }
  | { kind: 'handover-failed'; error: UiErrorView };

export type DiscardOutcome = { kind: 'discarded' } | { kind: 'failed'; error: UiErrorView };

export interface SendController {
  readonly runId: string;
  /** Start run (as part of its click chain) and Continue sending. A second call while one runs gets its outcome. */
  run(report?: StepReport): Promise<SendOutcome>;
  /**
   * "Discard this run…" after its sheet was confirmed (SPEC §3b step 7; S3): `POST /close {"discardUnfinished": true}`.
   * The uploaded text is deleted and the run ends without results.
   */
  discard(report?: StepReport): Promise<DiscardOutcome>;
}

declare module './registry.ts' {
  interface ControllerKinds { send: SendController }
}

type FullStatus = RunStatusResponse;

function createSendController(ctx: ControllerContext, registry: ControllerRegistry): SendController {
  const runId = ctx.id;
  const store: AppStore = ctx.store;
  const run: RunStore = store.runStore(runId);
  let released = false;
  const work = workTracker(() => {
    released = true;
    ctx.release();
  });
  const fresh = (): SendController => registry.send(runId);
  /** The TopBar activity pill's progress part ("57 of 114"). */
  const label = signal('');
  const copy = () => activeUiCopy.screenProgress;

  /** A fresh, full status read (never the poller's cached answer), applied to the RunStore as usual. */
  async function freshStatus(): Promise<FullStatus> {
    const fetched = await run.readStatus();
    if ('unchanged' in fetched.value) throw new UiShapeError('run status', 'unchanged', 'a full read answered "unchanged"');
    return fetched.value;
  }

  const dropped = (error: unknown, filename: string | null, report: StepReport): SendOutcome => {
    const view = presentError(error, 'send', filename === null ? {} : { filename });
    run.send.set({ kind: 'dropped', at: Date.now(), filename, error: view });
    report.problem(error, 'send');
    return { kind: 'dropped', error: view };
  };

  const noLocalText = (remaining: number, report: StepReport): SendOutcome => {
    run.send.set({ kind: 'idle' });
    report.problem(new NoLocalTextError(remaining), 'send');
    return { kind: 'no-local-text', remaining };
  };

  const finished = (total: number, report: StepReport): SendOutcome => {
    const at = Date.now();
    run.send.set({ kind: 'done', at });
    report.done(copy().sentDone(total, total));
    return { kind: 'done', at };
  };

  /**
   * The upload loop (SPEC §4.7): every prepared document the service does not hold, once, in quote order. Returns an
   * outcome when it stopped, or null when every document this browser holds is on the service (hand-over follows).
   */
  async function uploads(status: FullStatus, report: StepReport): Promise<SendOutcome | null> {
    const remaining = Math.max(0, status.run.total - status.run.uploaded);
    const localId = run.localId.peek() ?? readLocalForRun(runId);
    if (localId === null) return noLocalText(remaining, report);
    const records = await listLocalRecords(localId);
    if (records.length === 0) return noLocalText(remaining, report);
    // The same bodies as at Confirm (R13 compares them with what was confirmed).
    const frozen = await run.loadPlan();
    if (frozen === null) throw new Error('The frozen run selection could not be read.');
    const wanted = new Set(frozen.expected.map(item => item.fingerprint));
    const bakeoff = readDraftBakeoff(localId);
    if (frozen.bakeoff !== undefined && bakeoff === null) throw new Error(activeUiCopy.bakeoff.missing);
    const prepared = bakeoff === null
      ? prepareLocalRun(records.filter(record => wanted.has(record.fingerprint)), (await getProject()).value)
      : (await prepareFrozenBakeoff(bakeoff, bakeoffArm(bakeoff, localId), records)).prepared;
    if (bakeoff !== null && (frozen.bakeoff?.id !== bakeoff.id || frozen.bakeoff.arm !== bakeoffArm(bakeoff, localId) ||
        frozen.bakeoff.planHash !== readBakeoffCreated(bakeoff.id) || frozen.expected.length !== bakeoff.documents.length ||
        frozen.expected.some((item, index) => item.fingerprint !== bakeoff.documents[index].fingerprint)))
      throw new Error(activeUiCopy.bakeoff.missing);
    const serverHas = new Set(status.documents.map(document => document.fingerprint));
    const queue = uploadQueue(prepared.map(item => ({ fingerprint: item.quote.fingerprint, localState: item.local.state })), serverHas);
    const total = status.run.total;
    let sent = serverHas.size;
    const show = (lastAckAt: number | null) => {
      run.send.set({ kind: 'sending', sent, total, lastAckAt });
      label.set(copy().activity(sent, total));
      report.working(copy().sendingStep, { done: sent, total });
    };
    const local = await openLocalRunStore();
    try {
      // Documents the service already holds that this browser still has as read-not-sent (the tab that sent them
      // closed before it could note it): noted as sent, never sent again.
      for (const index of queue.onServer) {
        const item = prepared[index];
        if (item.local.state === 'extracted') await local.put({ ...item.local, state: 'uploaded' });
      }
      show(null);
      for (const index of queue.toSend) {
        const item = prepared[index];
        const filename = item.quote.originalFilename;
        try {
          await uploadDocument(runId, item.upload);
        } catch (error) {
          if (uploadFailureKind(error) === 'rejected') {
            const rejection = new DocumentRejectedError(filename, error);
            const view = presentError(rejection, 'send');
            // Remembered across reloads: the run then offers Discard only (acceptance sweep RS-1).
            writeSendRejected(runId, { filename, error: view, at: Date.now() });
            run.send.set({ kind: 'rejected', filename, error: view });
            report.problem(rejection, 'send');
            return { kind: 'rejected', filename, error: view };
          }
          return dropped(error, filename, report);
        }
        if (item.local.state === 'extracted') await local.put({ ...item.local, state: 'uploaded' });
        sent++;
        show(Date.now());
      }
    } finally {
      local.close();
      void run.loadLocalText();
    }
    return null;
  }

  /** The hand-over loop (SPEC §4.7): single flight under the same lock, a fresh status read before every `/start`. */
  async function handover(report: StepReport): Promise<SendOutcome> {
    for (;;) {
      const status = await freshStatus();
      const step = handoverStep(status.run);
      if (step === 'not-live') {
        if (handoverEnd(status.run.status) === 'done') return finished(status.run.total, report);
        run.send.set({ kind: 'idle' });
        report.clear();
        return { kind: 'stopped', status: status.run.status };
      }
      if (step === 'upload-incomplete') return noLocalText(status.run.total - status.run.uploaded, report);
      if (step === 'nothing-pending') return finished(status.run.total, report);
      const total = status.run.total, done = handedOver(status.run);
      run.send.set({ kind: 'handing-over', handedOver: done, total, lastStartAt: Date.now() });
      label.set(copy().activity(done, total));
      report.working(copy().handingOverStep, { done, total });
      let answer: { started: number; pending: number; status: RunStatus };
      try {
        answer = await startDispatch(runId);
      } catch (error) {
        // Never repeated. One status read tells a stopped run (its Stopped card speaks) from a live one.
        let after: RunStatus | null = null;
        try {
          after = (await freshStatus()).run.status;
        } catch {
          after = null;
        }
        if (afterHandoverFailure(after) === 'idle') {
          run.send.set({ kind: 'idle' });
          report.problem(error, 'send');
          return { kind: 'stopped', status: after };
        }
        const view = presentError(error, 'send');
        run.send.set({ kind: 'handover-failed', error: view });
        report.problem(error, 'send');
        return { kind: 'handover-failed', error: view };
      }
      if (!handoverAgain(answer)) {
        if (handoverEnd(answer.status) === 'done') return finished(total, report);
        run.send.set({ kind: 'idle' });
        report.clear();
        return { kind: 'stopped', status: answer.status };
      }
      await sleep(HANDOVER_GAP_MS);
    }
  }

  /** Everything under `dc:send:<runId>`. */
  async function sendLocked(report: StepReport): Promise<SendOutcome> {
    let reason: GuardReason = 'sending';
    guardOn(reason);
    label.set('');
    let end = ctx.begin('sending', label);
    // The stall rules read who holds the lock: refresh it (and the status) now, not at the next poll.
    run.poller.nudge();
    try {
      report.working(copy().checkingStep);
      let status: FullStatus;
      try {
        status = await freshStatus();
      } catch (error) {
        return dropped(error, null, report);
      }
      const entry = sendEntry(status.run);
      if (entry === 'not-live') {
        run.send.set({ kind: 'idle' });
        if (status.run.status === 'complete') report.done(copy().nothingToSend);
        else report.clear();
        return { kind: 'not-live', status: status.run.status };
      }
      if (entry === 'upload') {
        try {
          const stopped = await uploads(status, report);
          if (stopped !== null) return stopped;
        } catch (error) {
          // The local records or the project could not be read: nothing more is sent, and nothing is retried.
          return dropped(error, null, report);
        }
      }
      guardOff(reason);
      reason = 'handing-over';
      guardOn(reason);
      end();
      end = ctx.begin('handing-over', label);
      try {
        return await handover(report);
      } catch (error) {
        return dropped(error, null, report);
      }
    } finally {
      guardOff(reason);
      end();
    }
  }

  return {
    runId,

    run(report = NO_REPORT) {
      if (released) return fresh().run(report);
      return work.run('send', async () => {
        let result: { ran: true; value: SendOutcome } | { ran: false };
        try {
          result = await withLock(LOCK_NAMES.send(runId), () => sendLocked(report));
        } catch (error) {
          return dropped(error, null, report);
        } finally {
          // After the lock is released, so the next read sees it free.
          run.poller.nudge();
        }
        if (result.ran) return result.value;
        run.send.set({ kind: 'elsewhere' });
        report.problem(new ElsewhereError('send'), 'send');
        return { kind: 'elsewhere' };
      });
    },

    discard(report = NO_REPORT) {
      if (released) return fresh().discard(report);
      return work.run('discard', async () => {
        report.working(copy().discardingStep);
        try {
          await store.closeRun(runId, true, remaining => report.working(activeUiCopy.screenResults.close.remaining(remaining)));
        } catch (error) {
          report.problem(error, 'close');
          return { kind: 'failed', error: presentError(error, 'close') };
        }
        // The closed run is read before the outcome, so the view moves straight from Discard to its next step with the
        // outcome handed on. Clearing the refusal first briefly offered "Continue sending" on a refused run (acceptance
        // script 04); the refusal stays recorded, and Progress shows it only while the run is sending. A failed read
        // is the poller's to report, like any other.
        await run.readStatus().catch(() => run.poller.nudge());
        store.runListChanged();
        report.done(copy().discarded);
        return { kind: 'discarded' };
      });
    }
  };
}

export function register(registry: ControllerRegistry): void {
  registry.register('send', ctx => createSendController(ctx, registry));
}
