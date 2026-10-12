import { applyBakeoffCandidate, assertBakeoffManifest, bakeoffHash, prepareBakeoffManifest, type BakeoffCandidate } from '../../../core/bakeoff/plan.ts';
import { bakeoffArm, prepareFrozenBakeoff, refuseSameContent, type LocalBakeoff } from '../../../core/ui/bakeoff-local.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { prepareLocalRun } from '../../../core/local/preflight.ts';
import { cloneTrialRecord, readTrialSelection } from '../../../core/ui/trial-plan.ts';
import type { BakeoffView } from '../../../core/ui/bakeoff-wire.ts';
import type { LocalDocument } from '../../../core/local/state.ts';
import type { AppStore } from '../state/types.ts';
import { createBakeoff, getBakeoff, getBakeoffBaseline } from '../api/bakeoff.ts';
import { getReference } from '../api/endpoints.ts';
import {
  beginDraft, listLocalBakeoffs, markBakeoffCreated, onSharedKeyChange, readBakeoffCreated, readDraftBakeoff, readServerRun,
  writeLocalBakeoff
} from '../persist/local-keys.ts';
import { listLocalExtractions, listLocalRecords, openLocalRunStore } from '../persist/local-records.ts';
import { HANDLE_KEYS, readHandle, saveHandle } from '../persist/handles.ts';
import { LOCK_NAMES, withLock } from './locks.ts';
import type { ControllerRegistry } from './registry.ts';

export interface BakeoffDraftsInput {
  sourceRunId: string; referenceId: string; sourceLocalId: string; selected: readonly string[];
  candidate: BakeoffCandidate; baseline: Awaited<ReturnType<typeof getBakeoffBaseline>>; skipPilot: boolean;
}

/** Explicit local-only setup. Each clone gets empty ordinary budget fields and its own confirmation identity. */
export async function prepareBakeoffDrafts(store: AppStore, input: BakeoffDraftsInput): Promise<LocalBakeoff> {
  const c = activeUiCopy.bakeoff;
  if (input.selected.length === 0 || new Set(input.selected).size !== input.selected.length) throw new Error(c.noneSelected);
  const current = await getBakeoffBaseline();
  if (current.baselineHash !== input.baseline.baselineHash) throw new Error(c.stale);
  const reference = (await getReference(input.referenceId)).value;
  if (reference.definitionRevisionId !== input.baseline.baseline.pack.definitionRevisionId) throw new Error(c.stale);
  const referenced = new Set(reference.entries.map(entry => entry.fingerprint));
  if (input.selected.some(fingerprint => !referenced.has(fingerprint))) throw new Error(c.referenceMissing);
  const source = await listLocalRecords(input.sourceLocalId);
  refuseSameContent(source);
  const byId = new Map(source.map(record => [record.fingerprint, record]));
  const records = input.selected.map(fingerprint => { const record = byId.get(fingerprint); if (!record) throw new Error(c.missing); return record; });
  const pilotSize = input.baseline.baseline.pack.settings.pilotSize;
  if (!Number.isSafeInteger(pilotSize) || pilotSize! < 1) throw new Error(c.stale);
  if (records.length > pilotSize! && input.skipPilot !== true) throw new Error(c.pilotRequired(pilotSize!));
  const prepared = prepareLocalRun(records, input.baseline.baseline.pack), documents = await prepareBakeoffManifest(prepared);
  // A supported alternate must leave the complete prepared upload unchanged as well.
  assertBakeoffManifest(documents, await prepareBakeoffManifest(prepareLocalRun(records,
    applyBakeoffCandidate(input.baseline.baseline.pack, input.candidate))));
  const local: LocalBakeoff = { version: 1, id: crypto.randomUUID(), sourceRunId: input.sourceRunId,
    sourceLocalId: input.sourceLocalId, referenceId: input.referenceId, ...structuredClone(input.baseline),
    candidate: structuredClone(input.candidate), documents,
    localIds: { baseline: crypto.randomUUID(), candidate: crypto.randomUUID() }, ...(input.skipPilot ? { skipPilot: true } : {}) };
  const db = await openLocalRunStore();
  try {
    for (const localId of Object.values(local.localIds)) {
      beginDraft(localId, local.referenceId);
      for (const record of records) await db.put(cloneTrialRecord(record, localId));
      await store.draftStore(localId).setTrial(readTrialSelection({ version: 1, sourceLocalId: localId,
        role: 'ordinary', campaignId: null, trialRunId: null, order: [...input.selected], selected: [...input.selected],
        ...(local.skipPilot ? { skipPilot: true } : {}) }));
      const handle = await readHandle(HANDLE_KEYS.source(input.sourceLocalId));
      if (handle) await saveHandle(HANDLE_KEYS.source(localId), handle);
      await store.draftStore(localId).loadFiles();
    }
  } finally { db.close(); }
  writeLocalBakeoff(local);
  return local;
}

export async function loadBakeoffPreparation(localId: string) {
  const local = readDraftBakeoff(localId);
  if (local === null) return null;
  const arm = bakeoffArm(local, localId);
  const prepared = await prepareFrozenBakeoff(local, arm, await listLocalRecords(localId));
  const current = await getBakeoffBaseline();
  if (current.baselineHash !== local.baselineHash) throw new Error(activeUiCopy.bakeoff.stale);
  return { ...prepared, local, arm };
}

function verifyLocalPlan(local: LocalBakeoff, view: BakeoffView): void {
  if (view.plan.id !== local.id || view.plan.referenceId !== local.referenceId || view.plan.baselineHash !== local.baselineHash ||
      JSON.stringify(view.plan.candidate) !== JSON.stringify(local.candidate)) throw new Error(activeUiCopy.bakeoff.stale);
  assertBakeoffManifest(local.documents, view.plan.documents);
}

/** Called only by ordinary Start, after budgetFromDraft, while holding that arm's confirmation lock. */
export async function ensureBakeoffPlan(local: LocalBakeoff, localId: string): Promise<BakeoffView> {
  const created = readBakeoffCreated(local.id);
  if (created === null && bakeoffArm(local, localId) !== 'baseline') throw new Error(activeUiCopy.bakeoff.baselineFirst);
  const view = created === null ? await createBakeoff(local) : await getBakeoff(local.id);
  verifyLocalPlan(local, view);
  markBakeoffCreated(local.id, view.plan.planHash);
  return view;
}

/** Recovery is an explicit reselection, copying only missing records after verifying the original frozen hashes. */
export async function restoreBakeoffReadings(store: AppStore, local: LocalBakeoff, sourceLocalId: string): Promise<void> {
  const c = activeUiCopy.bakeoff, source = await listLocalRecords(sourceLocalId);
  const wanted = new Set(local.documents.map(document => document.fingerprint));
  const selected = source.filter(record => wanted.has(record.fingerprint));
  await prepareFrozenBakeoff(local, 'baseline', selected);
  for (const arm of ['baseline', 'candidate'] as const) {
    const localId = local.localIds[arm];
    const restore = async () => {
      const held = await listLocalRecords(localId), byId = new Map(held.map(record => [record.fingerprint, record]));
      if (held.length !== byId.size || held.some(record => !wanted.has(record.fingerprint))) throw new Error(c.missing);
      const pack = arm === 'baseline' ? local.baseline.pack : applyBakeoffCandidate(local.baseline.pack, local.candidate);
      const heldManifest = held.length === 0 ? [] : await prepareBakeoffManifest(prepareLocalRun(held, pack));
      for (const item of heldManifest) assertBakeoffManifest([local.documents.find(expected => expected.fingerprint === item.fingerprint)!], [item]);
      const db = await openLocalRunStore();
      try { for (const record of selected) if (!byId.has(record.fingerprint)) await db.put(cloneTrialRecord(record, localId)); }
      finally { db.close(); }
      await store.draftStore(localId).loadFiles();
    };
    const result = await withLock(LOCK_NAMES.confirm(localId), async () => {
      const runId = readServerRun(localId);
      if (runId === null) return restore();
      const sent = await withLock(LOCK_NAMES.send(runId), restore);
      if (!sent.ran) throw new Error(activeUiCopy.trial.selectionPending);
    });
    if (!result.ran) throw new Error(activeUiCopy.trial.selectionPending);
  }
}

export async function bakeoffPreparationKeys(local: LocalBakeoff, arm: 'baseline' | 'candidate') {
  return { payloadKey: await bakeoffHash(JSON.stringify(local.documents)),
    configurationKey: await bakeoffHash(JSON.stringify({ baselineHash: local.baselineHash, candidate: local.candidate, arm })) };
}

/**
 * The comparison panel on a run's saved-answer screen, keyed by that (source) run's id. It reads and prepares only
 * on this computer; creating the plan, quoting and starting stay with each arm's ordinary Confirm.
 */
export interface BakeoffController {
  /** The service's current baseline, checked against its hash. */
  baseline(): Promise<Pick<LocalBakeoff, 'baseline' | 'baselineHash'>>;
  /** The extractions held on this computer. */
  sources(): Promise<{ localId: string; files: number }[]>;
  /** One extraction's records. */
  records(localId: string): Promise<LocalDocument[]>;
  /** A new draft linked to the saved answers, for reading another folder. */
  newDraft(referenceId: string): string;
  /** The comparisons this computer prepared against the saved answers. */
  experiments(referenceId: string): LocalBakeoff[];
  /** Calls `listener` when another tab changes a comparison or a draft's run link; returns the unsubscribe. */
  watch(listener: () => void): () => void;
  /** The plan identity the service recorded for the comparison, or null before the baseline's Start. */
  created(experimentId: string): string | null;
  /** The run a draft started, or null. */
  serverRun(localId: string): string | null;
  prepare(input: Omit<BakeoffDraftsInput, 'sourceRunId'>): Promise<LocalBakeoff>;
  restore(local: LocalBakeoff, sourceLocalId: string): Promise<void>;
  /** The comparison as the service reads it now. */
  read(experimentId: string): Promise<BakeoffView>;
}
declare module './registry.ts' {
  interface ControllerKinds { bakeoff: BakeoffController }
}
export function register(registry: ControllerRegistry): void {
  registry.register('bakeoff', ctx => ({
    baseline: () => getBakeoffBaseline(),
    sources: () => listLocalExtractions(),
    records: localId => listLocalRecords(localId),
    newDraft: referenceId => beginDraft(crypto.randomUUID(), referenceId),
    experiments: referenceId => listLocalBakeoffs(referenceId),
    watch: listener => onSharedKeyChange(key => {
      if (key === null || key.startsWith('bakeoff') || key.startsWith('server-run:')) listener();
    }),
    created: experimentId => readBakeoffCreated(experimentId),
    serverRun: localId => readServerRun(localId),
    prepare: input => prepareBakeoffDrafts(ctx.store, { ...input, sourceRunId: ctx.id }),
    restore: (local, sourceLocalId) => restoreBakeoffReadings(ctx.store, local, sourceLocalId),
    read: experimentId => getBakeoff(experimentId)
  }));
}
