import type { BakeoffArm, BakeoffBaseline, BakeoffCandidate, BakeoffManifestDocument } from '../bakeoff/plan.ts';
import { applyBakeoffCandidate, assertBakeoffManifest, bakeoffHash, prepareBakeoffManifest, readBakeoffCandidate, readBakeoffManifest } from '../bakeoff/plan.ts';
import type { LocalDocument } from '../local/state.ts';
import { prepareLocalRun } from '../local/preflight.ts';
import { readProject } from './wire.ts';
import { bakeoffCopy } from './copy-bakeoff.ts';

/** Local immutable metadata only. Full extracted text remains in LocalRunStore. */
export interface LocalBakeoff {
  version: 1;
  id: string;
  sourceRunId: string;
  sourceLocalId: string;
  referenceId: string;
  baseline: BakeoffBaseline;
  baselineHash: string;
  candidate: BakeoffCandidate;
  documents: BakeoffManifestDocument[];
  localIds: Record<BakeoffArm, string>;
  skipPilot?: true;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export function readBakeoffBaseline(raw: unknown): BakeoffBaseline {
  if (!object(raw) || typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold) || raw.threshold < 0 || raw.threshold > 1 ||
      !text(raw.thresholdJustification) || !text(raw.buildCommit) || !hash(raw.requestContractHash)) throw new Error(bakeoffCopy.stale);
  readProject(raw.pack);
  return structuredClone(raw) as unknown as BakeoffBaseline;
}

export function readLocalBakeoff(raw: unknown): LocalBakeoff {
  if (!object(raw) || raw.version !== 1 || !text(raw.id) || !text(raw.sourceRunId) || !text(raw.sourceLocalId) ||
      !text(raw.referenceId) || !hash(raw.baselineHash) || !object(raw.localIds) || !text(raw.localIds.baseline) ||
      !text(raw.localIds.candidate) || raw.localIds.baseline === raw.localIds.candidate ||
      Object.hasOwn(raw, 'skipPilot') && raw.skipPilot !== true) throw new Error(bakeoffCopy.missing);
  const baseline = readBakeoffBaseline(raw.baseline), candidate = readBakeoffCandidate(raw.candidate);
  applyBakeoffCandidate(baseline.pack, candidate);
  return { version: 1, id: raw.id, sourceRunId: raw.sourceRunId, sourceLocalId: raw.sourceLocalId, referenceId: raw.referenceId,
    baseline, baselineHash: raw.baselineHash, candidate, documents: readBakeoffManifest(raw.documents),
    localIds: { baseline: raw.localIds.baseline, candidate: raw.localIds.candidate }, ...(raw.skipPilot === true ? { skipPilot: true } : {}) };
}

export function bakeoffArm(local: LocalBakeoff, localId: string): BakeoffArm {
  if (local.localIds.baseline === localId) return 'baseline';
  if (local.localIds.candidate === localId) return 'candidate';
  throw new Error(bakeoffCopy.missing);
}

/**
 * Two readings with the same content cannot both be compared (a folder read keeps every copy, DECISIONS 129c). This is
 * its own refusal, so the person is told to remove the extra copies rather than that readings are missing.
 */
export function refuseSameContent(records: readonly { fingerprint: string }[]): void {
  if (new Set(records.map(record => record.fingerprint)).size !== records.length) throw new Error(bakeoffCopy.sameContent);
}

/** Reject missing, extra, duplicate or changed payloads before either quote and again before sending. */
export async function prepareFrozenBakeoff(local: LocalBakeoff, arm: BakeoffArm, records: readonly LocalDocument[]) {
  refuseSameContent(records);
  const byId = new Map(records.map(record => [record.fingerprint, record]));
  if (records.length !== local.documents.length) throw new Error(bakeoffCopy.missing);
  const ordered = local.documents.map(document => {
    const record = byId.get(document.fingerprint);
    if (record === undefined) throw new Error(bakeoffCopy.missing);
    return record;
  });
  if (await bakeoffHash(JSON.stringify(local.baseline)) !== local.baselineHash) throw new Error(bakeoffCopy.stale);
  const pack = arm === 'baseline' ? local.baseline.pack : applyBakeoffCandidate(local.baseline.pack, local.candidate);
  const prepared = prepareLocalRun(ordered, pack);
  try { assertBakeoffManifest(local.documents, await prepareBakeoffManifest(prepared)); }
  catch { throw new Error(bakeoffCopy.missing); }
  return { pack, prepared };
}

export function localBakeoffCreateBody(local: LocalBakeoff) {
  return { id: local.id, referenceId: local.referenceId, baselineHash: local.baselineHash, candidate: local.candidate, documents: local.documents };
}
