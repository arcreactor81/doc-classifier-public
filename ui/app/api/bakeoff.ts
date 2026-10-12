import { request } from './client.ts';
import { bakeoffHash, verifyBakeoffPlan } from '../../../core/bakeoff/plan.ts';
import { readBakeoffBaseline, type LocalBakeoff, localBakeoffCreateBody } from '../../../core/ui/bakeoff-local.ts';
import { bakeoffCopy } from '../../../core/ui/copy-bakeoff.ts';
import { readBakeoffComparison, type BakeoffView } from '../../../core/ui/bakeoff-wire.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export async function readBakeoffView(raw: unknown): Promise<BakeoffView> {
  if (!object(raw) || !object(raw.arms)) throw new Error(bakeoffCopy.missing);
  const plan = await verifyBakeoffPlan(raw.plan);
  const arms = {} as BakeoffView['arms'];
  for (const arm of ['baseline', 'candidate'] as const) {
    const value = raw.arms[arm];
    if (!object(value) || ![value.quoteId, value.runId].every(item => item === null || typeof item === 'string' && item.length > 0))
      throw new Error(bakeoffCopy.missing);
    arms[arm] = { quoteId: value.quoteId as string | null, runId: value.runId as string | null };
  }
  const comparison = readBakeoffComparison(raw.comparison, plan);
  for (const arm of ['baseline', 'candidate'] as const) if (comparison.arms[arm].runId !== arms[arm].runId) throw new Error(bakeoffCopy.missing);
  return { plan, arms, comparison };
}
export async function getBakeoffBaseline() {
  const { value } = await request('GET', '/api/bakeoffs/baseline', { resourceKey: 'bakeoff-baseline' });
  if (!object(value) || typeof value.baselineHash !== 'string') throw new Error(bakeoffCopy.stale);
  const baseline = readBakeoffBaseline(value.baseline);
  if (await bakeoffHash(JSON.stringify(baseline)) !== value.baselineHash) throw new Error(bakeoffCopy.stale);
  return { baseline, baselineHash: value.baselineHash };
}
export async function createBakeoff(local: LocalBakeoff): Promise<BakeoffView> {
  const { value } = await request('POST', '/api/bakeoffs', { body: localBakeoffCreateBody(local) });
  return readBakeoffView(value);
}
export async function getBakeoff(id: string): Promise<BakeoffView> {
  const { value } = await request('GET', `/api/bakeoffs/${encodeURIComponent(id)}`, { resourceKey: `bakeoff:${id}` });
  return readBakeoffView(value);
}
