import { readBakeoffProvenance } from '../bakeoff/plan.ts';
import { VENDOR_PROMPTS } from '../vendors/requests.ts';
import { EXECUTION_ATTEMPTS } from './capabilities.ts';
import { ServerFailure } from './errors.ts';
import { readD1 } from './d1-write-policy.ts';
import { shaText, type RunRow, type Store } from './store.ts';

const copy = {
  identity: 'The saved comparison processing identity is missing or inconsistent. No new processing can start.',
  changed: 'The processing build or request contract changed after this comparison was prepared. Keep its recorded work and prepare a new comparison.'
};
interface ExecutionIdentity {
  owner: unknown; actor: unknown; id: unknown; quoteId: unknown;
  build: unknown; requestHash: unknown; planHash: unknown; manifestHash: unknown;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** The request contract a comparison freezes (plan.ts `requestContractHash`): the prompts and attempt policy in force. */
export const requestContractHash = (): Promise<string> =>
  shaText(JSON.stringify({ prompts: VENDOR_PROMPTS, attempts: EXECUTION_ATTEMPTS }));

/**
 * An existing run identity is recoverable across deployments; permission to do new comparison work is not.
 * Read only immutable scalar facts from the plan head, never its document manifest or today's active categories.
 * Ordinary historical runs make no extra query and acquire no new build requirement.
 */
export async function requireBakeoffExecution(env: Env, store: Store, run: RunRow): Promise<void> {
  if (run.bakeoff_json === null || run.bakeoff_json === undefined) return;
  const invalid = () => new ServerFailure('E_BAKEOFF_EXECUTION_IDENTITY', 'blocker', copy.identity);
  let provenance: ReturnType<typeof readBakeoffProvenance>;
  try { provenance = readBakeoffProvenance(JSON.parse(run.bakeoff_json)); }
  catch { throw invalid(); }
  const identity = await readD1<ExecutionIdentity>(store.env.DB.prepare(
    "SELECT b.actor AS owner,json_extract(b.plan_json,'$.actor') AS actor,json_extract(b.plan_json,'$.id') AS id,a.quote_id AS quoteId," +
    "json_extract(b.plan_json,'$.baseline.buildCommit') AS build,json_extract(b.plan_json,'$.baseline.requestContractHash') AS requestHash," +
    "json_extract(b.plan_json,'$.planHash') AS planHash,json_extract(b.plan_json,'$.manifestHash') AS manifestHash " +
    'FROM bakeoffs b JOIN bakeoff_arms a ON a.bakeoff_id=b.id AND a.arm=? WHERE b.id=?'
  ).bind(provenance.arm, provenance.id));
  if (!identity || identity.owner !== run.actor || identity.actor !== run.actor || identity.id !== provenance.id ||
      identity.quoteId !== run.quote_id || identity.planHash !== provenance.planHash || identity.manifestHash !== provenance.manifestHash ||
      typeof identity.build !== 'string' || identity.build.trim().length === 0 || !hash(identity.requestHash)) throw invalid();
  const currentRequestHash = await requestContractHash();
  if (identity.build !== env.BUILD_COMMIT || identity.requestHash !== currentRequestHash)
    throw new ServerFailure('E_BAKEOFF_EXECUTION_CHANGED', 'blocker', copy.changed);
}
