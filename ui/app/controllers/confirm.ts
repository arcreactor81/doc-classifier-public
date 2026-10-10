/**
 * The ConfirmController (SPEC §6.1; §4.7 steps 1–10 and "Boot recovery"; walkthrough 3a steps 7–8): one per
 * draft. It turns the draft's reviewed files into a run: prepare → quote → confirm intent → create → links → first
 * status check, then the Progress view and the SendController, all inside the person's Start run click. Logic only
 * (SPEC §4.1 L2): it writes the DraftStore (`prepared`, `confirm`, the intent and the links through `linkRun`) and
 * reports to the caller's feedback slot (`StepReport`).
 *
 * - Nothing is ever re-sent by a timer, at boot or after an error (SPEC §0.1 rule 3). A `POST /api/runs` that got no
 *   certain answer leaves the confirm intent pending; only the person's "Finish starting this run" posts the same
 *   `{quoteId, budget}` again, and the service answers with the run it made (200) or makes it (201).
 * - The confirm intent is written before `POST /api/runs`, and the run id into it after (crash safety, SPEC §4.3).
 * - Single flight: Web Lock `dc:confirm:<localId>` across tabs; one piece of work at a time in this tab (a second
 *   click while one runs gets the running one's outcome).
 * - The draft is frozen once it has a run: Start run then only goes to that run.
 * - Every run is Interactive: the quote body says so as a constant (confirm-plan.ts `quoteBody`); nothing is chosen.
 * - "The project changed" refusals re-prepare locally, keep the limits, clear the no-limit acknowledgement, show what
 *   changed, and stop: there is no automatic re-quote.
 * - It never changes the address unless the person is still on this draft's views (SPEC §2.6 rules 2–3).
 */
import { initialSelection, selectTrialRecords, selectionCampaign } from '../../../core/ui/trial-plan.ts';
import { computed, signal, type Read, type Signal } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { presentError, type UiErrorView } from '../../../core/ui/error-copy.ts';
import type { Phrase } from '../../../core/ui/journey.ts';
import { budgetFromDraft, confirmBlockers, preparedChanges, type PreparedChange } from '../../../core/ui/confirm-form.ts';
import { UiRequestError } from '../../../core/ui/request-error.ts';
import {
  changedPhrases, createFailure, finishFailure, preparedSummary, preparedReader, projectChanged, quoteBody, retryShortfall,
  stillOnDraft, storageResult, withPreparation, type StorageResult
} from '../../../core/ui/confirm-plan.ts';
import {
  ConfirmBlockedError, ElsewhereError, HintedError, NO_REPORT, NotStartedError, PreparationChangedError, workTracker,
  type StepReport
} from '../../../core/ui/run-controls.ts';
import { typeVersion, type ProjectPack } from '../../../core/config/project.ts';
import { prepareLocalRun, type PreparedDocument } from '../../../core/local/preflight.ts';
import { createRun, getProject, getReference, getPilot, getUsage, listRuns, quote } from '../api/endpoints.ts';
import { readRetry, readRetryMissing, readRetryCampaign, readServerRun, readDraftBakeoff, readUnrefusedConfirmIntent, type ConfirmIntent } from '../persist/local-keys.ts';
import { bakeoffPreparationKeys, ensureBakeoffPlan, loadBakeoffPreparation } from './bakeoff.ts';
import { listLocalRecords } from '../persist/local-records.ts';
import { navigate } from '../router.ts';
import type { AppStore, DraftStore, PreparedSummary } from '../state/types.ts';
import { LOCK_NAMES, withLock } from './locks.ts';
import type { ControllerContext, ControllerRegistry } from './registry.ts';
import type { SendOutcome } from './send.ts';

export type ConfirmOutcome =
  /** The run exists and is checked; the Progress view is shown (if the person is still here) and sending started. */
  | { kind: 'started'; runId: string; created: boolean; storage: StorageResult; send: Promise<SendOutcome> }
  /** The draft had already started this run: the page goes to it. */
  | { kind: 'frozen'; runId: string }
  /** Start run still has reasons it is unavailable; nothing was sent. */
  | { kind: 'blocked'; reasons: readonly Phrase[] }
  /** Something changed since the person reviewed the run; nothing was sent. */
  | { kind: 'changed'; parts: readonly PreparedChange[] }
  /** Another tab of this browser is starting this run. */
  | { kind: 'elsewhere' }
  /** No certain answer to `POST /api/runs`: the run may exist. "Finish starting this run" is the next step. */
  | { kind: 'intent-pending'; quoteId: string; error: UiErrorView }
  /** "Finish starting this run" learnt that nothing was started; the form is back to editing. */
  | { kind: 'not-started'; error: UiErrorView }
  | { kind: 'failed'; error: UiErrorView };

export interface ConfirmController {
  loadUsage(): ReturnType<typeof getUsage>;
  readonly localId: string;
  /**
   * Why Start run is unavailable now (confirm-form.ts `confirmBlockers` over the draft and Health), empty when it can
   * run; for ActionSpec.blockedBy. After a failed preparation "Getting the run ready…" gives way to what happened.
   */
  readonly blockers: Read<readonly Phrase[]>;
  /** The browser's answer about keeping this computer's saved text, after a successful Start run (Details only). */
  readonly storage: Read<StorageResult | null>;
  /**
   * What Confirm shows (`DraftStore.prepared`): the documents to send, how many could not be read, and the categories
   * they are checked against. The view calls it on mount; it reads the project and the local records only (GETs).
   */
  prepare(report?: StepReport): Promise<PreparedSummary | null>;
  /** Start run (SPEC §4.7 steps 1–10). A pending confirmation is finished instead, never replaced. */
  start(report?: StepReport): Promise<ConfirmOutcome>;
  /** Finish starting this run: the same `{quoteId, budget}` again (SPEC §4.7 "Boot recovery"). */
  finishStarting(report?: StepReport): Promise<ConfirmOutcome>;
}

declare module './registry.ts' {
  interface ControllerKinds { confirm: ConfirmController }
}

/** One answer per draft, shared by every instance for that draft (an instance is dropped when its work ends). */
const storageAnswers = new Map<string, Signal<StorageResult | null>>();
function storageAnswer(localId: string): Signal<StorageResult | null> {
  let answer = storageAnswers.get(localId);
  if (answer === undefined) {
    answer = signal<StorageResult | null>(null);
    storageAnswers.set(localId, answer);
  }
  return answer;
}

const samePhrases = (a: readonly Phrase[], b: readonly Phrase[]) => JSON.stringify(a) === JSON.stringify(b);
const iso = () => new Date(Date.now()).toISOString();

/** SPEC §4.3 "Storage persistence": asked once the browser has not already agreed to keep this computer's text. */
async function keepStorage(): Promise<StorageResult> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (storage === undefined || typeof storage.persist !== 'function') return 'unavailable';
  try {
    if (typeof storage.persisted === 'function' && await storage.persisted()) return 'kept';
    return storageResult(await storage.persist());
  } catch {
    // A browser that cannot answer is recorded as not having said (Details only); the run is not affected.
    return storageResult(null);
  }
}

interface Preparation { pack: ProjectPack; prepared: PreparedDocument[]; summary: PreparedSummary;
  bakeoff?: NonNullable<Awaited<ReturnType<typeof loadBakeoffPreparation>>> }

/** Internal: a finished locked step, and what follows it once the lock is released. */
type Locked =
  | { kind: 'outcome'; outcome: ConfirmOutcome }
  | { kind: 'run'; runId: string; created: boolean; storage: StorageResult };

function createConfirmController(ctx: ControllerContext, registry: ControllerRegistry): ConfirmController {
  const localId = ctx.id;
  const store: AppStore = ctx.store;
  const draft: DraftStore = store.draftStore(localId);
  let released = false;
  const work = workTracker(() => {
    released = true;
    ctx.release();
  });
  /** A caller that kept this instance after its work ended is served by the registry's current one. */
  const fresh = (): ConfirmController => registry.confirm(localId);
  const storage = storageAnswer(localId);
  const copy = () => activeUiCopy.screenConfirm;

  const blockers = computed<readonly Phrase[]>(() => {
    const health = store.health();
    const reasons = confirmBlockers({
      budgetDraft: draft.budget(),
      acknowledged: draft.acknowledgeUnlimited(),
      prepared: draft.prepared(),
      health: health.state === 'ready' ? { ready: health.value.ready, emergencyStop: health.value.emergencyStop } : null,
      duplicates: draft.counts().duplicates
    });
    return withPreparation(reasons, draft.prepared() === null && draft.confirm().kind === 'failed');
  }, { equals: samePhrases });

  const frozenRun = (): string | null => draft.runId.peek() ?? readServerRun(localId);
  const working = (step: 'preparing' | 'quoting' | 'creating' | 'checking', report: StepReport) => {
    draft.confirm.set({ kind: 'working', step });
    report.working(copy().steps[step]);
  };
  /** Records a failure beneath Start run. A pending intent or a started run keeps its own state. */
  const failed = (error: unknown, report: StepReport): ConfirmOutcome => {
    const view = presentError(error, 'confirm');
    const state = draft.confirm.peek().kind;
    if (state !== 'intent-pending' && state !== 'done') draft.confirm.set({ kind: 'failed', error: view });
    report.problem(error, 'confirm');
    return { kind: 'failed', error: view };
  };

  /** The run this browser would start now: the project, this draft's records, and what Confirm would show. */
  async function freshPreparation(): Promise<Preparation> {
    const bakeoff = await loadBakeoffPreparation(localId);
    if (bakeoff !== null) {
      const selection = await draft.loadTrial();
      if (selection === null || JSON.stringify(selection.selected) !== JSON.stringify(bakeoff.local.documents.map(document => document.fingerprint)) ||
          selection.role !== 'ordinary' || selection.skipPilot !== bakeoff.local.skipPilot) throw new Error(activeUiCopy.bakeoff.locked);
      draft.applyRecords(bakeoff.prepared.map(item => item.local));
      const summary = preparedSummary(bakeoff.prepared.map(item => ({ failed: item.quote.failed })), {
        typeVersion: await typeVersion(JSON.stringify(bakeoff.pack.typeFile)), categoryCount: bakeoff.pack.typeFile.types.length,
        revisionId: bakeoff.pack.definitionRevisionId ?? null, ...preparedReader(bakeoff.pack)
      });
      Object.assign(summary, await bakeoffPreparationKeys(bakeoff.local, bakeoff.arm), { selectionKey: JSON.stringify(selection.selected) });
      return { pack: bakeoff.pack, prepared: bakeoff.prepared, summary, bakeoff };
    }
    const requestedSelection = await draft.loadTrial();
    const pack = (await getProject(requestedSelection?.selectedReaderModel)).value;
    const records = await listLocalRecords(localId);
    draft.applyRecords(records);
    const shortfall = retryShortfall(readRetry(localId), records, readRetryMissing(localId));
    if (shortfall !== null) throw shortfall;
    let selection = await draft.loadTrial();
    if (selection === null) {
      // Only preparation outside Start initializes selection. Never acquire its non-reentrant lock from Start.
      if (draft.confirmationPending.peek()) throw new PreparationChangedError(['total']);
      selection = initialSelection(localId, records, pack.settings.pilotSize!);
      const campaign=readRetryCampaign(localId);
      if(campaign)selection={...selection,role:campaign.role,campaignId:campaign.role==='full'?campaign.id:null,trialRunId:campaign.role==='full'?draft.retryOf:null,
        selected:campaign.role==='full'?[...selection.order]:selection.order.slice(0,pack.settings.pilotSize!)};
      await draft.setTrial(selection, { fillsDefault: true });
    }
    if (pack.readerModels !== undefined && selection.selectedReaderModel === undefined) {
      if (draft.confirmationPending.peek()) throw new PreparationChangedError(['configuration']);
      selection = { ...selection, selectedReaderModel: pack.readerModels.defaultId };
      await draft.setTrial(selection, { fillsDefault: true });
    }
    if (pack.selectedReaderModel !== selection.selectedReaderModel) throw new PreparationChangedError(['configuration']);
    if (selection.role === 'full') {
      const candidate = selection.trialRunId;
      const trialId = candidate !== null && candidate !== draft.retryOf ? candidate
        : (await listRuns()).value.find(run => run.campaign?.id === selection.campaignId && run.campaign.role === 'pilot')?.id;
      if (!trialId) throw new Error(activeUiCopy.trial.stale);
      const reviewed = (await getPilot(trialId)).value;
      if (reviewed.campaignId !== selection.campaignId || !reviewed.confirmation || !reviewed.categoryVersion.matches)
        throw new Error(activeUiCopy.trial.stale);
    }
    const selected = selectTrialRecords(records, selection);
    if (selection.role === 'pilot' && (selected.length < 1 || selected.length > (pack.settings.pilotSize!)))
      throw new Error(activeUiCopy.trial.max(pack.settings.pilotSize!));
    const prepared = prepareLocalRun(selected, pack);
    const summary = preparedSummary(prepared.map(item => ({ failed: item.quote.failed })), {
      typeVersion: await typeVersion(JSON.stringify(pack.typeFile)),
      categoryCount: pack.typeFile.types.length,
      revisionId: pack.definitionRevisionId ?? null, ...preparedReader(pack)
    });
    summary.selectionKey = JSON.stringify({ role: selection.role, campaignId: selection.campaignId, selected: selection.selected, ...(selection.skipPilot ? { skipPilot: true } : {}) });
    return { pack, prepared, summary };
  }

  /** SPEC §4.7 step 3: what changed is shown, the acknowledgement is cleared, and the person checks it again. */
  function changed(parts: readonly PreparedChange[], summary: PreparedSummary, report: StepReport): Locked {
    draft.prepared.set(summary);
    draft.acknowledgeUnlimited.set(false);
    draft.confirm.set({ kind: 'changed', differences: changedPhrases(parts) });
    report.problem(new PreparationChangedError(parts), 'confirm');
    return { kind: 'outcome', outcome: { kind: 'changed', parts } };
  }

  /**
   * The service says the project changed after the preparation (API §12.17): prepare again locally and stop. When
   * nothing Confirm shows differs (for example a setting changed), the service's own sentence is shown instead.
   */
  async function reprepared(refusal: unknown, report: StepReport): Promise<Locked> {
    if (readDraftBakeoff(localId) !== null) {
      draft.acknowledgeUnlimited.set(false);
      return { kind: 'outcome', outcome: failed(new Error(activeUiCopy.bakeoff.stale), report) };
    }
    working('preparing', report);
    const again = await freshPreparation();
    const shown = draft.prepared.peek();
    const parts = shown === null ? [] : preparedChanges(shown, again.summary);
    if (parts.length > 0) return changed(parts, again.summary, report);
    draft.prepared.set(again.summary);
    draft.acknowledgeUnlimited.set(false);
    draft.confirm.set({ kind: 'editing' });
    report.problem(refusal, 'confirm');
    return { kind: 'outcome', outcome: { kind: 'failed', error: presentError(refusal, 'confirm') } };
  }

  /** The run whose answers this draft is checked against, for the "Update my answers" link (R6; a GET). */
  async function withAnswersLink(error: unknown): Promise<unknown> {
    const referenceId = draft.referenceId.peek();
    if (!(error instanceof UiRequestError) || error.code !== 'E_FEEDBACK_REFERENCE' || referenceId === null) return error;
    try {
      return new HintedError(error, { sourceRunId: (await getReference(referenceId)).value.sourceRunId });
    } catch {
      return error;
    }
  }

  /** SPEC §4.7 steps 7–9 (and "Finish starting this run"): create, link, keep storage, the first status check. */
  async function createAndCheck(intent: ConfirmIntent, report: StepReport, finishing: boolean): Promise<Locked> {
    working('creating', report);
    let created: { runId: string; created: boolean };
    try {
      created = await createRun({ quoteId: intent.quoteId, budget: intent.budget });
    } catch (error) {
      // A first request refused with a 4xx made no run. When finishing, the first request got no certain answer, so
      // only a refusal of the request itself ends the pending state (confirm-plan.ts `finishFailure`).
      const failure = finishing ? finishFailure(error) : createFailure(error);
      if (failure === 'uncertain') {
        // The run may exist. Only the person's "Finish starting this run" asks again, with the same confirmation.
        const view = presentError(error, 'confirm');
        draft.confirm.set({ kind: 'intent-pending', quoteId: intent.quoteId });
        report.problem(error, 'confirm');
        return { kind: 'outcome', outcome: { kind: 'intent-pending', quoteId: intent.quoteId, error: view } };
      }
      // Persist the definite refusal separately: reloads/tabs agree, while the original intent is retained.
      draft.refuseIntent(intent.quoteId);
      if (failure === 'not-started') {
        const nothing = new NotStartedError('The service refused the stored confirmation; no run was started.', error);
        draft.confirm.set({ kind: 'editing' });
        report.problem(nothing, 'confirm');
        return { kind: 'outcome', outcome: { kind: 'not-started', error: presentError(nothing, 'confirm') } };
      }
      if (projectChanged(error)) return reprepared(error, report);
      throw error;
    }
    // The draft is frozen before anything else can happen (DraftStore.linkRun writes the links in a crash-safe order).
    draft.linkRun(created.runId);
    store.runListChanged();
    const kept = await keepStorage();
    storage.set(kept);

    working('checking', report);
    // The first status check: the run's view is there when Progress opens. A failed read is not a failed start: the
    // run exists, and the SendController reads its status again before any upload.
    await store.runStore(created.runId).readStatus().catch(() => undefined);
    draft.confirm.set({ kind: 'done', runId: created.runId });
    report.done(copy().started);
    return { kind: 'run', runId: created.runId, created: created.created, storage: kept };
  }

  /** SPEC §4.7 steps 2–9 under `dc:confirm:<localId>`. */
  async function startLocked(report: StepReport): Promise<Locked> {
    const frozen = frozenRun();
    if (frozen !== null) return { kind: 'outcome', outcome: { kind: 'frozen', runId: frozen } };
    // Checked again inside the lock: another tab may have left a pending confirmation meanwhile.
    const pending = readUnrefusedConfirmIntent(localId);
    if (pending !== null && pending.runId === null) {
      draft.writeIntent(pending);
      return createAndCheck(pending, report, true);
    }
    const reasons = blockers.peek();
    const shown = draft.prepared.peek();
    if (reasons.length > 0 || shown === null) {
      const blocked = new ConfirmBlockedError(reasons);
      report.problem(blocked, 'confirm');
      return { kind: 'outcome', outcome: { kind: 'blocked', reasons: blocked.reasons } };
    }

    // Step 3: the files and the categories as they are now, against what Confirm showed.
    working('preparing', report);
    const now = await freshPreparation();
    const parts = preparedChanges(shown, now.summary);
    if (parts.length > 0) return changed(parts, now.summary, report);

    // Step 4: the spending decision (it may throw its plain sentence).
    const budget = budgetFromDraft(draft.budget.peek(), draft.acknowledgeUnlimited.peek());

    // Creating an experiment records metadata only, after this arm's ordinary spending decision. It cannot start
    // either arm; the candidate remains a separate draft with its own empty spending form and Start action.
    const experiment = now.bakeoff === undefined ? null : await ensureBakeoffPlan(now.bakeoff.local, localId);

    // Step 5: the quote (Interactive, always) with, only when there are saved answers, the reference.
    working('quoting', report);
    let quoted;
    try {
      quoted = await quote({ ...quoteBody(now.prepared.map(item => item.quote), draft.referenceId.peek(), selectionCampaign(draft.trial.peek()!), draft.trial.peek()!.skipPilot, now.pack.selectedReaderModel),
        ...(now.bakeoff === undefined ? {} : { bakeoff: { id: now.bakeoff.local.id, arm: now.bakeoff.arm } }) });
    } catch (error) {
      if (projectChanged(error)) return reprepared(error, report);
      throw await withAnswersLink(error);
    }
    // The categories changed between the preparation and the quote: prepare again and let the person check.
    if (quoted.typeVersion !== now.summary.typeVersion) return reprepared(new PreparationChangedError(['categories']), report);
    if (now.bakeoff !== undefined && (quoted.bakeoff?.id !== now.bakeoff.local.id || quoted.bakeoff.arm !== now.bakeoff.arm ||
        quoted.bakeoff.planHash !== experiment!.plan.planHash || quoted.bakeoff.manifestHash !== experiment!.plan.manifestHash))
      throw new Error(activeUiCopy.bakeoff.stale);

    if (quoted.selectedReaderModel !== now.pack.selectedReaderModel ||
        quoted.readerModel !== undefined && JSON.stringify(quoted.readerModel) !== JSON.stringify(now.summary.readerModel) ||
        now.pack.readerModels !== undefined && quoted.readerModel === undefined)
      throw new Error(copy().readerChanged);

    // Step 6: the intent, before the run is asked for.
    const intent: ConfirmIntent = { quoteId: quoted.quoteId, budget, typeVersion: quoted.typeVersion, at: iso(), runId: null,
      ...(now.summary.readerModel === undefined ? {} : { readerModel: now.summary.readerModel }) };
    draft.writeIntent(intent);
    return createAndCheck(intent, report, false);
  }

  async function finishLocked(report: StepReport): Promise<Locked> {
    const frozen = frozenRun();
    if (frozen !== null) return { kind: 'outcome', outcome: { kind: 'frozen', runId: frozen } };
    const intent = readUnrefusedConfirmIntent(localId);
    if (intent === null || intent.runId !== null) {
      const nothing = new NotStartedError('There is no stored confirmation waiting to be finished.');
      draft.confirm.set({ kind: 'editing' });
      report.problem(nothing, 'confirm');
      return { kind: 'outcome', outcome: { kind: 'not-started', error: presentError(nothing, 'confirm') } };
    }
    draft.writeIntent(intent);
    return createAndCheck(intent, report, true);
  }

  /** Runs `step` under the confirm lock, then (outside it) goes to the run and starts sending (SPEC §4.7 step 10). */
  async function locked(step: (report: StepReport) => Promise<Locked>, report: StepReport): Promise<ConfirmOutcome> {
    let result: { ran: true; value: Locked } | { ran: false };
    try {
      result = await withLock(LOCK_NAMES.confirm(localId), async () => {
        try {
          return await step(report);
        } catch (error) {
          return { kind: 'outcome', outcome: failed(error, report) } as Locked;
        }
      });
    } catch (error) {
      return failed(error, report);
    }
    if (!result.ran) {
      // Another tab is starting this run. If it already has, this draft follows it (the stored link).
      draft.confirm.set({ kind: 'elsewhere' });
      const linked = readServerRun(localId);
      if (linked !== null && draft.runId.peek() === null) draft.runId.set(linked);
      report.problem(new ElsewhereError('confirm'), 'confirm');
      return { kind: 'elsewhere' };
    }
    const value = result.value;
    if (value.kind === 'outcome') {
      if (value.outcome.kind === 'frozen') {
        report.clear();
        if (stillOnDraft(store.route.peek(), localId)) navigate({ view: 'run', runId: value.outcome.runId });
      }
      return value.outcome;
    }
    // The documented result of the click: the run's Progress view, while the person is still on this draft.
    if (stillOnDraft(store.route.peek(), localId)) navigate({ view: 'progress', runId: value.runId });
    const send = registry.send(value.runId).run(NO_REPORT);
    return { kind: 'started', runId: value.runId, created: value.created, storage: value.storage, send };
  }

  return {
    localId,
    loadUsage: () => getUsage(),
    blockers,
    storage: Object.assign(() => storage(), { peek: () => storage.peek() }),

    prepare(report = NO_REPORT) {
      if (released) return fresh().prepare(report);
      if (draft.confirmationPending.peek()) return Promise.resolve(draft.prepared.peek());
      return work.run('prepare', async () => {
        if (frozenRun() !== null) return draft.prepared.peek();
        try {
          const { summary } = await freshPreparation();
          const before = draft.prepared.peek();
          // CUI §16: a changed preparation clears the no-limit acknowledgement.
          if (before !== null && preparedChanges(before, summary).length > 0) draft.acknowledgeUnlimited.set(false);
          draft.prepared.set(summary);
          if (draft.confirm.peek().kind === 'failed') draft.confirm.set({ kind: 'editing' });
          report.clear();
          return summary;
        } catch (error) {
          const state = draft.confirm.peek().kind;
          if (state === 'editing' || state === 'failed' || state === 'changed')
            draft.confirm.set({ kind: 'failed', error: presentError(error, 'confirm') });
          report.problem(error, 'confirm');
          return null;
        }
      });
    },

    start(report = NO_REPORT) {
      if (released) return fresh().start(report);
      return work.run('confirm', async () => {
        draft.confirmationPending.set(true);
        try { return await locked(startLocked, report); }
        finally { draft.confirmationPending.set(false); }
      });
    },

    finishStarting(report = NO_REPORT) {
      if (released) return fresh().finishStarting(report);
      return work.run('confirm', async () => {
        draft.confirmationPending.set(true);
        try { return await locked(finishLocked, report); }
        finally { draft.confirmationPending.set(false); }
      });
    }
  };
}

export function register(registry: ControllerRegistry): void {
  registry.register('confirm', ctx => createConfirmController(ctx, registry));
}
