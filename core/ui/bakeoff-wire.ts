import type { BakeoffPlan } from '../bakeoff/plan.ts';
import type { BakeoffArmSummary, BakeoffComparison, BakeoffPairDetail } from '../bakeoff/comparison.ts';
import { UiShapeError } from './wire.ts';

type ArmView = Omit<BakeoffArmSummary, 'reference'> & { reference: Pick<BakeoffArmSummary['reference'],
  'sourceTotal' | 'newDocuments' | 'ambiguous' | 'excluded' | 'unconfirmed' | 'sourceFailures'> };
export type BakeoffComparisonView = Omit<BakeoffComparison, 'arms'> & { arms: Record<'baseline' | 'candidate', ArmView> };
/** One comparison as the service reports it (checked by ui/app/api/bakeoff.ts). */
export interface BakeoffView {
  plan: BakeoffPlan;
  arms: Record<'baseline' | 'candidate', { quoteId: string | null; runId: string | null }>;
  comparison: BakeoffComparisonView;
}
const fail = (path: string): never => { throw new UiShapeError('configuration comparison', path, 'the comparison is missing, inconsistent or invalid'); };
function obj(value: unknown, path: string): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(path);
}
const count = (value: unknown, path: string): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail(path);
const bool = (value: unknown, path: string): boolean => typeof value === 'boolean' ? value : fail(path);
const nullableText = (value: unknown, path: string): string | null => value === null || typeof value === 'string' && value.length > 0 ? value : fail(path);
function spend(value: unknown, path: string) {
  const o = obj(value, path);
  for (const key of ['openai', 'typesafe', 'blended']) if (typeof o[key] !== 'string' || !/^\d+$/.test(o[key])) fail(path);
  if (BigInt(o.openai as string) + BigInt(o.typesafe as string) !== BigInt(o.blended as string)) fail(path);
  return { openai: o.openai as string, typesafe: o.typesafe as string, blended: o.blended as string };
}
function ratio(value: unknown, path: string, names: readonly string[]) {
  const o = obj(value, path), result: Record<string, number | null> = {};
  for (const key of names) result[key] = count(o[key], `${path}.${key}`);
  if (o.rate !== null && (typeof o.rate !== 'number' || !Number.isFinite(o.rate) || o.rate < 0 || o.rate > 1)) fail(path);
  result.rate = o.rate as number | null;
  return result;
}
export function readBakeoffComparison(raw: unknown, plan: BakeoffPlan): BakeoffComparisonView {
  const o = obj(raw, '');
  if (o.version !== 1 || o.planId !== plan.id || o.planHash !== plan.planHash || o.basis !== 'independent-full-pipeline-arms' ||
      o.selectedCount !== plan.documents.length) fail('plan');
  const inputArms = obj(o.arms, 'arms'), arms = {} as Record<'baseline' | 'candidate', ArmView>;
  for (const key of ['baseline', 'candidate'] as const) {
    const a = obj(inputArms[key], key), reference = obj(a.reference, `${key}.reference`);
    const runId = nullableText(a.runId, key), status = a.status;
    if (!['not_started', 'uploading', 'running', 'complete', 'halted', 'closing', 'closed'].includes(String(status)) ||
        (runId === null) !== (status === 'not_started')) fail(key);
    const result = { runId, status } as ArmView;
    if (Object.hasOwn(a, 'vendors')) {
      if (a.vendors !== 'fake' || runId === null) fail(`${key}.vendors`);
      result.vendors = 'fake';
    }
    for (const field of ['planned', 'uploaded', 'decided', 'missing', 'pending', 'filed', 'review', 'failures', 'unknownCostAttempts', 'pendingAccounting'] as const)
      result[field] = count(a[field], `${key}.${field}`);
    for (const field of ['classificationComplete', 'accountingComplete', 'provisional'] as const) result[field] = bool(a[field], `${key}.${field}`);
    if (result.planned !== plan.documents.length || result.uploaded + result.missing !== result.planned ||
        result.decided + result.pending !== result.uploaded || result.filed + result.review + result.failures !== result.decided ||
        result.classificationComplete !== (['complete', 'closed'].includes(result.status) && result.decided === result.planned) || result.provisional === result.classificationComplete ||
        result.accountingComplete !== (runId !== null && result.unknownCostAttempts === 0 && result.pendingAccounting === 0)) fail(key);
    result.precision = ratio(a.precision, `${key}.precision`, ['correct', 'wrong', 'of']) as unknown as ArmView['precision'];
    result.reviewLoad = ratio(a.reviewLoad, `${key}.reviewLoad`, ['count', 'of']) as unknown as ArmView['reviewLoad'];
    if (result.precision.correct + result.precision.wrong !== result.precision.of || result.precision.of > result.filed ||
        result.precision.rate !== (result.precision.of ? result.precision.correct / result.precision.of : null) ||
        result.reviewLoad.count !== result.review || result.reviewLoad.of !== result.planned || result.reviewLoad.rate !== result.review / result.planned) fail(key);
    result.reference = {} as ArmView['reference'];
    for (const field of ['sourceTotal', 'newDocuments', 'ambiguous', 'excluded', 'unconfirmed', 'sourceFailures'] as const)
      result.reference[field] = count(reference[field], `${key}.reference.${field}`);
    if (result.reference.sourceTotal !== result.planned) fail(key);
    result.spend = a.spend === null ? null : spend(a.spend, `${key}.spend`);
    if ((result.spend === null) !== (runId === null)) fail(key);
    result.durationMs = a.durationMs === null ? null : count(a.durationMs, `${key}.durationMs`);
    arms[key] = result;
  }
  const paired = obj(o.paired, 'paired'), details = paired.details;
  const simulated = arms.baseline.vendors === 'fake' || arms.candidate.vendors === 'fake';
  if (Object.hasOwn(o, 'vendors') ? o.vendors !== 'fake' || !simulated : simulated) fail('vendors');
  if (!Array.isArray(details) || details.length !== plan.documents.length) fail('paired.details');
  const parsedPairs = (details as unknown[]).map((raw, index): BakeoffPairDetail => {
    const d = obj(raw, `paired.${index}`);
    if (d.fingerprint !== plan.documents[index].fingerprint) fail('paired.identity');
    const result = { fingerprint: d.fingerprint as string, baselinePresent: bool(d.baselinePresent, 'paired'), candidatePresent: bool(d.candidatePresent, 'paired'),
      baselineRule: nullableText(d.baselineRule, 'paired'), candidateRule: nullableText(d.candidateRule, 'paired'),
      baselineFolder: nullableText(d.baselineFolder, 'paired'), candidateFolder: nullableText(d.candidateFolder, 'paired'),
      changed: d.changed === null ? null : bool(d.changed, 'paired') };
    for (const arm of ['baseline', 'candidate'] as const) {
      const rule = result[`${arm}Rule`], folder = result[`${arm}Folder`];
      if ((rule === null) !== (folder === null) || rule !== null && !['R0', 'R0n', 'R1', 'R2', 'R3', 'R4', 'R5'].includes(rule) ||
          rule !== null && !result[`${arm}Present`]) fail('paired.outcome');
      if (rule === 'R1' ? !plan.baseline.pack.typeFile.types.some(type => type.id === folder)
        : rule === 'R0' ? folder !== 'could_not_process' : rule !== null && folder !== 'human_review') fail('paired.folder');
    }
    if (result.changed !== (result.baselineRule === null || result.candidateRule === null ? null :
        result.baselineRule !== result.candidateRule || result.baselineFolder !== result.candidateFolder)) fail('paired.changed');
    return result;
  });
  const pairedResult = { details: parsedPairs } as BakeoffComparison['paired'];
  for (const field of ['terminalPairs', 'sameOutcomes', 'changedOutcomes', 'onlyBaselineOutcome', 'onlyCandidateOutcome', 'neitherOutcome'] as const)
    pairedResult[field] = count(paired[field], `paired.${field}`);
  if (pairedResult.sameOutcomes + pairedResult.changedOutcomes !== pairedResult.terminalPairs || pairedResult.terminalPairs +
      pairedResult.onlyBaselineOutcome + pairedResult.onlyCandidateOutcome + pairedResult.neitherOutcome !== plan.documents.length) fail('paired.totals');
  for (const arm of ['baseline', 'candidate'] as const) {
    const present = parsedPairs.filter(detail => detail[`${arm}Present`]).length;
    const decided = parsedPairs.filter(detail => detail[`${arm}Rule`] !== null).length;
    if (present !== arms[arm].uploaded || decided !== arms[arm].decided) fail(`paired.${arm}`);
  }
  if (pairedResult.changedOutcomes !== parsedPairs.filter(detail => detail.changed === true).length ||
      pairedResult.sameOutcomes !== parsedPairs.filter(detail => detail.changed === false).length ||
      pairedResult.onlyBaselineOutcome !== parsedPairs.filter(detail => detail.baselineRule !== null && detail.candidateRule === null).length ||
      pairedResult.onlyCandidateOutcome !== parsedPairs.filter(detail => detail.baselineRule === null && detail.candidateRule !== null).length ||
      pairedResult.neitherOutcome !== parsedPairs.filter(detail => detail.baselineRule === null && detail.candidateRule === null).length) fail('paired.totals');
  const spending = obj(o.spending, 'spending'), known = spend(spending.known, 'spending.known');
  const total = spending.total === null ? null : spend(spending.total, 'spending.total');
  const accountingComplete = bool(o.accountingComplete, 'accountingComplete'), classificationComplete = bool(o.classificationComplete, 'classificationComplete');
  if (classificationComplete !== (arms.baseline.classificationComplete && arms.candidate.classificationComplete) ||
      accountingComplete !== (arms.baseline.accountingComplete && arms.candidate.accountingComplete) || (total === null) === accountingComplete) fail('complete');
  const referenceTotal = count(o.referenceTotal, 'referenceTotal'), outsideSelection = count(o.outsideSelection, 'outsideSelection');
  if (referenceTotal !== plan.documents.length + outsideSelection) fail('referenceTotal');
  const spendingResult = { recordedArms: count(spending.recordedArms, 'spending.recordedArms'), known, total,
    unknownCostAttempts: count(spending.unknownCostAttempts, 'spending.unknownCostAttempts'), pendingAccounting: count(spending.pendingAccounting, 'spending.pendingAccounting') };
  if (spendingResult.recordedArms !== Number(arms.baseline.spend !== null) + Number(arms.candidate.spend !== null) ||
      spendingResult.unknownCostAttempts !== arms.baseline.unknownCostAttempts + arms.candidate.unknownCostAttempts ||
      spendingResult.pendingAccounting !== arms.baseline.pendingAccounting + arms.candidate.pendingAccounting) fail('spending.totals');
  for (const field of ['openai', 'typesafe', 'blended'] as const) if (BigInt(known[field]) !==
      BigInt(arms.baseline.spend?.[field] ?? '0') + BigInt(arms.candidate.spend?.[field] ?? '0') || total !== null && total[field] !== known[field]) fail('spending.totals');
  return { ...(simulated ? { vendors: 'fake' as const } : {}),
    version: 1, planId: plan.id, planHash: plan.planHash, basis: 'independent-full-pipeline-arms', referenceTotal,
    selectedCount: plan.documents.length, outsideSelection, classificationComplete, accountingComplete, arms,
    paired: pairedResult, spending: spendingResult };
}
