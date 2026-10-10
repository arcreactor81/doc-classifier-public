import { modelFamily, readerOutputCap, typeVersion, vendorModelIds, type ProjectPack } from '../config/project.ts';
import { capsExempt } from '../config/definitions.ts';
import { DEEPSEEK_POOL_ID, NANODOLLARS_PER_NEURON, TYPESAFE_POOL_ID, WORKERS_AI_POOL_ID, tokenPoolForModel, utcUsageDay } from '../config/usage-limits.ts';
import { outbound } from '../vendors/outbound.ts';
import { actorRunCount, readDailyUsage, type DailyPool } from './daily-usage.ts';
import { dailyRecordAllowance, dailyRecordCount, type DailyRecordKind } from './daily-allowance.ts';
import { ServerFailure } from './errors.ts';
import { usageCopy } from '../ui/copy-usage.ts';

/** `neurons`: the Workers AI pool, kept in nanodollars and shown in whole Neurons, rounded up (DECISIONS 136). */
export interface UsagePoolSummary {
  id: string; unit: 'tokens' | 'nanodollars' | 'neurons'; limitUnits: number; usedUnits: number;
  reservedUnits: number; unknownCalls: number; blocked: boolean;
}
export interface ReaderUsageEstimate {
  id: string; model: string; sampleDocuments: number; averageCostNanoPerDocument: string | null;
  estimatedDocumentsPerDay: number | null; estimatedDocumentsRemaining: number | null;
}
export type UsageSummary = { enabled: false } | {
  enabled: true; resetsAt: string; maxDocumentsPerRun: number; maxRunsPerActorPerDay: number;
  /** `actorExempt`: a listed category editor or trusted user, exempt from the per-person caps (`capsExempt`, DECISIONS 150). */
  actorRunsToday: number; actorExempt: boolean;
  /** The three daily allowances (daily-allowance.ts): price checks (quotes), saved reviews (corrections), saved labels (references). */
  actorQuotesToday: number; maxQuotesPerActorPerDay: number; actorCorrectionsToday: number; maxCorrectionsPerActorPerDay: number;
  actorReferencesToday: number; maxReferencesPerActorPerDay: number;
  pools: UsagePoolSummary[]; readerModels: ReaderUsageEstimate[];
};
interface Sample { readerTokens: number; readerNano: number; recoveryTokens: number; confidenceNano: number; totalNano: number }
const validCount = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const bad = () => new ServerFailure('E_DAILY_USAGE_STORAGE', 'blocker', usageCopy.storage);

/** Signed-in, aggregate-only inspection. Measurements never enter the frozen pack or a confirmation's hash. */
export async function readUsageSummary(
  env: { DB: D1Database; DEFINITION_EDITORS?: string; TRUSTED_USERS?: string }, pack: ProjectPack, actor: string, at = new Date().toISOString()
): Promise<UsageSummary> {
  const limits = pack.settings.usageLimits;
  if (!limits) return { enabled: false };
  const date = utcUsageDay(at);
  const configured: { pool: DailyPool; limitUnits: number }[] = [
    ...limits.openaiTokenPools.map(pool => ({ pool: { id: 'openai/' + pool.id, unit: 'tokens' as const, modelIds: pool.modelIds }, limitUnits: pool.limitTokens })),
    { pool: { id: TYPESAFE_POOL_ID, unit: 'nanodollars', modelIds: [pack.pins.confidence.id] }, limitUnits: Number(limits.typesafeDailyNano) },
    ...(limits.policy === 'daily-usage-v2' ? [
      { pool: { id: WORKERS_AI_POOL_ID, unit: 'nanodollars' as const, modelIds: vendorModelIds('cloudflare') }, limitUnits: limits.workersAiDailyNeurons * NANODOLLARS_PER_NEURON },
      { pool: { id: DEEPSEEK_POOL_ID, unit: 'nanodollars' as const, modelIds: vendorModelIds('deepseek') }, limitUnits: Number(limits.deepseekDailyNano) }
    ] : [])
  ];
  const states = await Promise.all(configured.map(async ({ pool, limitUnits }) => ({ pool, limitUnits, state: await readDailyUsage(env.DB, pool, at) })));
  const neurons = (nano: number) => Math.ceil(nano / NANODOLLARS_PER_NEURON);
  const pools: UsagePoolSummary[] = states.map(({ pool, limitUnits, state }) => {
    const shown = pool.id === WORKERS_AI_POOL_ID ? neurons : (value: number) => value;
    return { id: pool.id, unit: pool.id === WORKERS_AI_POOL_ID ? 'neurons' : pool.unit, limitUnits: shown(limitUnits),
      usedUnits: shown(state.usedUnits), reservedUnits: shown(state.reservedUnits), unknownCalls: state.unknownCalls,
      // A reserved unknown call is already charged at its reservation in usedUnits; only an unreserved one refuses the pool.
      blocked: state.invalidRows > 0 || state.overruns > 0 || state.unreservedUnknownCalls > 0 || state.usedUnits + state.reservedUnits >= limitUnits };
  });
  // The same count the run admission applies: a trial and its first full run are one run.
  const counted = actorRunCount(actor, at);
  const count = await env.DB.prepare('SELECT ' + counted.sql + ' AS n').bind(...counted.params).first<{ n: number }>();
  if (!count || !validCount(count.n)) throw bad();
  // The same counts a price check, a saved review and a save of confirmed labels apply (daily-allowance.ts), under the
  // same allowance. A saved review or label save is held to the limits frozen on its run: these, unless the pack changed.
  const kinds: readonly DailyRecordKind[] = ['quote', 'correction', 'reference'];
  const recordCounts = kinds.map(kind => dailyRecordCount(kind, actor, at));
  const records = await env.DB.prepare('SELECT ' + recordCounts.map((counted, i) => counted.sql + ' AS ' + kinds[i]).join(', '))
    .bind(...recordCounts.flatMap(counted => counted.params)).first<Record<DailyRecordKind, number>>();
  if (!records || kinds.some(kind => !validCount(records[kind]))) throw bad();
  const recordLimit = dailyRecordAllowance(limits);
  const version = await typeVersion(JSON.stringify(pack.typeFile));
  // Each option's own frozen settings: an experimental reader's effort and per-run output cap (7 October 2026). The project
  // cap is the pack's own unless its recorded choice derived the cap from a rule, which this read cannot undo.
  const recorded = pack.readerModels?.options.find(option => option.id === (pack.selectedReaderModel ?? pack.readerModels?.defaultId));
  if (recorded?.outputCap !== undefined) throw bad();
  const options = pack.readerModels?.options.map(option => ({ id: option.id, pin: option.pin, effort: option.readerEffort ?? pack.settings.readerEffort,
    cap: option.outputCap === undefined ? pack.settings.readerMaxOutputTokens : readerOutputCap(option.outputCap, pack.typeFile.types.length) }))
    ?? [{ id: pack.pins.reader.id, pin: pack.pins.reader, effort: pack.settings.readerEffort, cap: pack.settings.readerMaxOutputTokens }];
  const settings = pack.settings;
  const readerModels: ReaderUsageEstimate[] = [];
  for (const option of options) {
    const samples = (await env.DB.prepare(`
      SELECT SUM(CASE WHEN v.role='reader' THEN v.token_units ELSE 0 END) AS readerTokens,
        SUM(CASE WHEN v.role='reader' THEN v.nano_units ELSE 0 END) AS readerNano,
        SUM(CASE WHEN v.role='recovery' THEN v.token_units ELSE 0 END) AS recoveryTokens,
        SUM(CASE WHEN v.role='confidence' THEN v.nano_units ELSE 0 END) AS confidenceNano,
        SUM(v.nano_units) AS totalNano
      FROM daily_vendor_usage v JOIN runs r ON r.id=v.run_id
      JOIN documents d ON d.run_id=v.run_id AND d.fingerprint=v.fingerprint
      WHERE d.status='complete' AND r.type_version=?
        AND json_extract(r.pack_json,'$.pins.reader.id')=? AND json_extract(r.pack_json,'$.pins.reader.policy')=?
        AND json_extract(r.pack_json,'$.pins.recovery.id')=? AND json_extract(r.pack_json,'$.pins.confidence.id')=?
        AND json_extract(r.pack_json,'$.settings.readerEffort')=?
        AND json_extract(r.pack_json,'$.settings.readerMaxOutputTokens')=?
        AND json_extract(r.pack_json,'$.settings.readerContract')=?
        AND json_extract(r.pack_json,'$.settings.recoveryEffort')=?
        AND json_extract(r.pack_json,'$.settings.recoveryMaxOutputTokens')=?
        AND json_extract(r.pack_json,'$.settings.confidenceQuestionPolicy')=?
        AND json_extract(r.pack_json,'$.settings.confidenceStatePolicy')=?
        AND EXISTS(SELECT 1 FROM json_each(r.notes_json) WHERE value='N_FAKE_VENDORS')=?
      GROUP BY r.id,d.fingerprint
      HAVING SUM(CASE WHEN v.nano_units IS NULL OR (v.role!='confidence' AND v.token_units IS NULL) THEN 1 ELSE 0 END)=0
        AND SUM(CASE WHEN v.role='reader' THEN 1 ELSE 0 END)>0
    `).bind(version, option.pin.id, option.pin.policy, pack.pins.recovery.id, pack.pins.confidence.id,
      option.effort, option.cap, settings.readerContract!, settings.recoveryEffort,
      settings.recoveryMaxOutputTokens, settings.confidenceQuestionPolicy!, settings.confidenceStatePolicy,
      outbound.vendors === 'fake' ? 1 : 0).all<Sample>()).results;
    if (!Array.isArray(samples) || samples.some(sample => Object.values(sample).some(value => !validCount(value)))) throw bad();
    const estimate: ReaderUsageEstimate = { id: option.id, model: option.pin.id, sampleDocuments: samples.length,
      averageCostNanoPerDocument: null, estimatedDocumentsPerDay: null, estimatedDocumentsRemaining: null };
    if (samples.length === 0) { readerModels.push(estimate); continue; }
    const totals = samples.reduce((sum, row) => ({ readerTokens: sum.readerTokens + BigInt(row.readerTokens),
      readerNano: sum.readerNano + BigInt(row.readerNano),
      recoveryTokens: sum.recoveryTokens + BigInt(row.recoveryTokens), confidenceNano: sum.confidenceNano + BigInt(row.confidenceNano),
      totalNano: sum.totalNano + BigInt(row.totalNano) }), { readerTokens: 0n, readerNano: 0n, recoveryTokens: 0n, confidenceNano: 0n, totalNano: 0n });
    const n = BigInt(samples.length);
    estimate.averageCostNanoPerDocument = ((totals.totalNano + n - 1n) / n).toString();
    // The reader's own pool: OpenAI tokens, or the Workers AI / DeepSeek nanodollar pool of its vendor.
    const vendor = modelFamily('reader', option.pin)?.vendor ?? 'openai';
    const recoveryPool = tokenPoolForModel(limits, pack.pins.recovery.id);
    const readerPool = vendor === 'openai' ? tokenPoolForModel(limits, option.pin.id) : null;
    if (!recoveryPool || vendor === 'openai' && !readerPool) throw bad();
    const consumption = new Map<string, bigint>([[TYPESAFE_POOL_ID, totals.confidenceNano]]);
    for (const [id, amount] of [
      vendor === 'openai' ? ['openai/' + readerPool!.id, totals.readerTokens] as const
        : [vendor === 'cloudflare' ? WORKERS_AI_POOL_ID : DEEPSEEK_POOL_ID, totals.readerNano] as const,
      ['openai/' + recoveryPool.id, totals.recoveryTokens] as const])
      consumption.set(id, (consumption.get(id) ?? 0n) + amount);
    const dayBounds: bigint[] = [], remainingBounds: bigint[] = [];
    let unknown = false;
    for (const [id, used] of consumption) {
      const scoped = states.find(value => value.pool.id === id);
      if (!scoped) throw bad();
      const { state, limitUnits } = scoped;
      // Any unknown call, reserved or not: some of today's usage is not known, so no remaining figure is claimed.
      if (state.unknownCalls || state.overruns || state.invalidRows) unknown = true;
      if (used === 0n) continue;
      dayBounds.push(BigInt(limitUnits) * n / used);
      remainingBounds.push(BigInt(Math.max(0, limitUnits - state.usedUnits - state.reservedUnits)) * n / used);
    }
    const minimum = (bounds: bigint[]) => {
      if (bounds.length === 0) return null;
      const result = bounds.reduce((left, right) => left < right ? left : right);
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw bad();
      return Number(result);
    };
    estimate.estimatedDocumentsPerDay = minimum(dayBounds);
    estimate.estimatedDocumentsRemaining = unknown ? null : minimum(remainingBounds);
    readerModels.push(estimate);
  }
  return { enabled: true, resetsAt: date.resetsAt, maxDocumentsPerRun: limits.maxDocumentsPerRun,
    maxRunsPerActorPerDay: limits.maxRunsPerActorPerDay, actorRunsToday: count.n,
    actorExempt: capsExempt(env.DEFINITION_EDITORS, env.TRUSTED_USERS, actor),
    actorQuotesToday: records.quote, maxQuotesPerActorPerDay: recordLimit, actorCorrectionsToday: records.correction,
    maxCorrectionsPerActorPerDay: recordLimit, actorReferencesToday: records.reference, maxReferencesPerActorPerDay: recordLimit,
    pools, readerModels };
}
