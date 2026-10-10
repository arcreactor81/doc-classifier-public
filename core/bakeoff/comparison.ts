/** Factual comparison of independent full-pipeline arms. No ranking, recommendation or adoption is computed. */
import { compareReference, type ComparisonDocument } from '../correction/comparison.ts';
import { uniqueFingerprints, type ReferenceEntry } from '../correction/reference.ts';
import type { Spend } from '../cost/run-budget.ts';
import {
  BakeoffFailure, readBakeoffManifest, readBakeoffProvenance,
  type BakeoffArm, type BakeoffPlan, type BakeoffProvenance
} from './plan.ts';

export type BakeoffRunStatus = 'uploading' | 'running' | 'complete' | 'halted' | 'closing' | 'closed';
export interface BakeoffComparisonDocument extends ComparisonDocument { inputHash: string }
export interface BakeoffArmInput {
  /** Present only when the run's saved notes explicitly record simulated vendors. */
  vendors?: 'fake';
  runId: string;
  provenance: BakeoffProvenance;
  status: BakeoffRunStatus;
  expectedCount: number;
  documents: readonly BakeoffComparisonDocument[];
  /** Known incurred spending only; unresolved attempts are counted separately, never assigned zero cost. */
  spend: Spend;
  unknownCostAttempts: number;
  pendingAccounting: number;
  /** A recorded measured duration, or explicitly unavailable. No timing is inferred by this module. */
  durationMs: number | null;
}
export interface BakeoffArmSummary {
  vendors?: 'fake';
  runId: string | null;
  status: BakeoffRunStatus | 'not_started';
  planned: number;
  uploaded: number;
  decided: number;
  missing: number;
  pending: number;
  filed: number;
  review: number;
  failures: number;
  classificationComplete: boolean;
  accountingComplete: boolean;
  provisional: boolean;
  precision: { correct: number; wrong: number; of: number; rate: number | null };
  reviewLoad: { count: number; of: number; rate: number | null };
  reference: ReturnType<typeof compareReference>;
  spend: Spend | null;
  unknownCostAttempts: number;
  pendingAccounting: number;
  durationMs: number | null;
}
export interface BakeoffPairDetail {
  fingerprint: string;
  baselinePresent: boolean;
  candidatePresent: boolean;
  baselineRule: string | null;
  candidateRule: string | null;
  baselineFolder: string | null;
  candidateFolder: string | null;
  /** Null if either outcome is unavailable; otherwise compares recorded rule and folder. */
  changed: boolean | null;
}
export interface BakeoffComparison {
  /** At least one recorded arm used simulated vendors; absence never supplies a live-vendor claim. */
  vendors?: 'fake';
  version: 1;
  planId: string;
  planHash: string;
  basis: 'independent-full-pipeline-arms';
  referenceTotal: number;
  selectedCount: number;
  outsideSelection: number;
  classificationComplete: boolean;
  accountingComplete: boolean;
  arms: Record<BakeoffArm, BakeoffArmSummary>;
  paired: {
    terminalPairs: number;
    sameOutcomes: number;
    changedOutcomes: number;
    onlyBaselineOutcome: number;
    onlyCandidateOutcome: number;
    neitherOutcome: number;
    details: BakeoffPairDetail[];
  };
  spending: {
    recordedArms: number;
    known: Spend;
    /** Current recorded total, unavailable if an arm is unstarted or any accounting remains unresolved. */
    total: Spend | null;
    unknownCostAttempts: number;
    pendingAccounting: number;
  };
}

const STATUSES: readonly string[] = ['uploading', 'running', 'complete', 'halted', 'closing', 'closed'];
const REVIEW_RULES: ReadonlySet<string> = new Set(['R0n', 'R2', 'R3', 'R4', 'R5']);
const REF_STATUSES: readonly string[] = ['label', 'ambiguous', 'excluded', 'unconfirmed', 'failure'];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BakeoffFailure('E_BAKEOFF_COMPARISON', message);
}
function referenceCheck(condition: unknown): asserts condition {
  if (!condition) throw new BakeoffFailure('E_BAKEOFF_REFERENCE',
    'The selected comparison needs unchanged, valid saved answers for every selected identity.');
}
function checkedSpend(value: Spend): Spend {
  check(value !== null && typeof value === 'object' && Object.keys(value).length === 3 &&
    ['openai', 'typesafe', 'blended'].every(key => Object.hasOwn(value, key) &&
      typeof value[key as keyof Spend] === 'string' && /^[0-9]+$/.test(value[key as keyof Spend])),
  'The comparison spending record is incomplete or invalid.');
  check(BigInt(value.blended) === BigInt(value.openai) + BigInt(value.typesafe),
    'The comparison spending subtotals do not match its recorded total.');
  return { ...value };
}
function checkedReference(reference: readonly ReferenceEntry[], typeIds: ReadonlySet<string>): Map<string, ReferenceEntry> {
  referenceCheck(Array.isArray(reference));
  let indexed: Map<string, ReferenceEntry>;
  try { indexed = uniqueFingerprints(reference); }
  catch { throw new BakeoffFailure('E_BAKEOFF_REFERENCE', 'Saved answers contain a missing or repeated document identity.'); }
  for (const entry of reference) {
    referenceCheck(/^[0-9a-f]{64}$/.test(entry.fingerprint) && present(entry.originalFilename) &&
      present(entry.previousFolder) && present(entry.previousRule) && typeof entry.moved === 'boolean' &&
      REF_STATUSES.includes(entry.status) && Array.isArray(entry.labels) &&
      entry.labels.every((id: unknown) => typeof id === 'string' && typeIds.has(id)) && new Set(entry.labels).size === entry.labels.length);
    referenceCheck(entry.status === 'label' ? entry.labels.length === 1
      : entry.status === 'ambiguous' ? entry.labels.length >= 2 : entry.labels.length === 0);
    referenceCheck((entry.previousRule === 'R0') === (entry.status === 'failure'));
  }
  return indexed;
}

/** Requires a previously verified plan and the owned reference identified by that plan. */
export function compareBakeoff(
  plan: BakeoffPlan,
  reference: readonly ReferenceEntry[],
  inputs: Record<BakeoffArm, BakeoffArmInput | null>
): BakeoffComparison {
  const manifest = readBakeoffManifest(plan.documents), expected = new Map(manifest.map(d => [d.fingerprint, d]));
  const typeIds = new Set(plan.baseline.pack.typeFile.types.map(type => type.id));
  const references = checkedReference(reference, typeIds);
  const selected = manifest.map(doc => {
    const entry = references.get(doc.fingerprint);
    referenceCheck(entry !== undefined);
    return entry;
  });
  check(inputs !== null && typeof inputs === 'object' && Object.keys(inputs).length === 2 &&
    Object.hasOwn(inputs, 'baseline') && Object.hasOwn(inputs, 'candidate'),
  'The comparison must identify both arms, including an unstarted arm.');
  for (const input of [inputs.baseline, inputs.candidate]) check(input === null ||
    typeof input === 'object' && !Array.isArray(input), 'The comparison arm is unavailable.');
  if (inputs.baseline !== null && inputs.candidate !== null)
    check(inputs.baseline.runId !== inputs.candidate.runId, 'The two comparison arms cannot share one run.');

  const documentMaps = {} as Record<BakeoffArm, Map<string, BakeoffComparisonDocument>>;
  function summarize(arm: BakeoffArm): BakeoffArmSummary {
    const input = inputs[arm];
    let documents: readonly BakeoffComparisonDocument[] = [];
    if (input !== null) {
      const identity = readBakeoffProvenance(input.provenance);
      check(identity.id === plan.id && identity.arm === arm && identity.planHash === plan.planHash &&
        identity.manifestHash === plan.manifestHash, 'The run belongs to a different comparison or arm.');
      check(present(input.runId) && STATUSES.includes(input.status) && input.expectedCount === manifest.length &&
        Array.isArray(input.documents), 'The run does not match its planned comparison size or state.');
      check(integer(input.unknownCostAttempts) && integer(input.pendingAccounting) &&
        (input.durationMs === null || integer(input.durationMs)),
      'The comparison requires recorded accounting counts and measured timing availability.');
      checkedSpend(input.spend);
      check(!Object.hasOwn(input, 'vendors') || input.vendors === 'fake',
        'The comparison contains an invalid recorded model-service identity.');
      documents = input.documents;
    }
    let indexed: Map<string, BakeoffComparisonDocument>;
    try { indexed = uniqueFingerprints(documents); }
    catch { throw new BakeoffFailure('E_BAKEOFF_COMPARISON', 'The run contains a missing or repeated document identity.'); }
    for (const doc of documents) {
      const frozen = expected.get(doc.fingerprint);
      check(frozen !== undefined && doc.inputHash === frozen.uploadHash,
        'The run contains an input outside the frozen comparison readings.');
      check(!frozen.failed || doc.rule === null || doc.rule === 'R0',
        'A recorded reading failure cannot have a classification outcome.');
      check(doc.rule === null ? doc.destinationFolder === null
        : doc.rule === 'R0' ? doc.destinationFolder === 'could_not_process'
          : doc.rule === 'R1' ? typeof doc.destinationFolder === 'string' && typeIds.has(doc.destinationFolder)
            : typeof doc.rule === 'string' && REVIEW_RULES.has(doc.rule) && doc.destinationFolder === 'human_review',
      'A recorded outcome has an unknown rule or a conflicting destination.');
    }
    documentMaps[arm] = indexed;
    const result = compareReference(selected, documents);
    const filed = documents.filter(doc => doc.rule === 'R1').length;
    const review = documents.filter(doc => doc.rule !== null && REVIEW_RULES.has(doc.rule)).length;
    const failures = documents.filter(doc => doc.rule === 'R0').length;
    const decided = filed + review + failures;
    const classificationComplete = input !== null && ['complete', 'closed'].includes(input.status) &&
      documents.length === manifest.length && decided === manifest.length;
    const scored = result.details.filter(doc => doc.actualRule === 'R1' && doc.status === 'label' && doc.exclusionReason === null);
    const correct = scored.filter(doc => doc.matches).length;
    return {
      ...(input?.vendors === 'fake' ? { vendors: 'fake' as const } : {}),
      runId: input?.runId ?? null, status: input?.status ?? 'not_started', planned: manifest.length,
      uploaded: documents.length, decided, missing: manifest.length - documents.length,
      pending: documents.length - decided, filed, review, failures, classificationComplete,
      accountingComplete: input !== null && input.unknownCostAttempts === 0 && input.pendingAccounting === 0,
      provisional: !classificationComplete,
      precision: { correct, wrong: scored.length - correct, of: scored.length,
        rate: scored.length === 0 ? null : correct / scored.length },
      reviewLoad: { count: review, of: manifest.length, rate: review / manifest.length },
      reference: result, spend: input === null ? null : checkedSpend(input.spend),
      unknownCostAttempts: input?.unknownCostAttempts ?? 0, pendingAccounting: input?.pendingAccounting ?? 0,
      durationMs: input?.durationMs ?? null
    };
  }
  const arms = { baseline: summarize('baseline'), candidate: summarize('candidate') };
  const paired: BakeoffComparison['paired'] = { terminalPairs: 0, sameOutcomes: 0, changedOutcomes: 0,
    onlyBaselineOutcome: 0, onlyCandidateOutcome: 0, neitherOutcome: 0, details: [] };
  for (const doc of manifest) {
    const baseline = documentMaps.baseline.get(doc.fingerprint), candidate = documentMaps.candidate.get(doc.fingerprint);
    const hasBaseline = baseline !== undefined && baseline.rule !== null;
    const hasCandidate = candidate !== undefined && candidate.rule !== null;
    let changed: boolean | null = null;
    if (hasBaseline && hasCandidate) {
      paired.terminalPairs++;
      changed = baseline.rule !== candidate.rule || baseline.destinationFolder !== candidate.destinationFolder;
      if (changed) paired.changedOutcomes++;
      else paired.sameOutcomes++;
    } else if (hasBaseline) paired.onlyBaselineOutcome++;
    else if (hasCandidate) paired.onlyCandidateOutcome++;
    else paired.neitherOutcome++;
    paired.details.push({ fingerprint: doc.fingerprint, baselinePresent: baseline !== undefined,
      candidatePresent: candidate !== undefined, baselineRule: baseline?.rule ?? null, candidateRule: candidate?.rule ?? null,
      baselineFolder: baseline?.destinationFolder ?? null, candidateFolder: candidate?.destinationFolder ?? null, changed });
  }
  const known: Spend = { openai: '0', typesafe: '0', blended: '0' };
  let recordedArms = 0;
  for (const summary of Object.values(arms)) if (summary.spend !== null) {
    recordedArms++;
    for (const dimension of ['openai', 'typesafe', 'blended'] as const)
      known[dimension] = (BigInt(known[dimension]) + BigInt(summary.spend[dimension])).toString();
  }
  const unknownCostAttempts = arms.baseline.unknownCostAttempts + arms.candidate.unknownCostAttempts;
  const pendingAccounting = arms.baseline.pendingAccounting + arms.candidate.pendingAccounting;
  check(Number.isSafeInteger(unknownCostAttempts) && Number.isSafeInteger(pendingAccounting),
    'The combined accounting counts exceed the supported exact range.');
  const accountingComplete = arms.baseline.accountingComplete && arms.candidate.accountingComplete;
  return {
    ...(arms.baseline.vendors === 'fake' || arms.candidate.vendors === 'fake' ? { vendors: 'fake' as const } : {}),
    version: 1, planId: plan.id, planHash: plan.planHash, basis: 'independent-full-pipeline-arms',
    referenceTotal: reference.length, selectedCount: manifest.length, outsideSelection: reference.length - selected.length,
    classificationComplete: arms.baseline.classificationComplete && arms.candidate.classificationComplete,
    accountingComplete, arms, paired,
    spending: { recordedArms, known, total: accountingComplete ? { ...known } : null, unknownCostAttempts, pendingAccounting }
  };
}
