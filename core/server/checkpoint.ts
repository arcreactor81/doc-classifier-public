import { ServerFailure, failure, serverCopy } from './errors.ts';
import type { ArtifactRegistration } from './artifact-persistence.ts';
import type { PersistedEvent } from './event-persistence.ts';
/**
 * What commits atomically with a stage's finishing transition: the single ledger row of a non-text artifact whose
 * object is already stored, and the stage's completion event. Either is optional; neither is written without the finish.
 */
export interface StageCompletion {
  readonly artifact?: ArtifactRegistration;
  readonly event?: PersistedEvent;
}
export interface StageResult { readonly key: string; readonly completion: StageCompletion }
export interface CheckpointStore {
  claim(name: string): Promise<{ state: 'claimed' | 'uncertain' } | { state:'failed';error:{code:string;kind:'blocker'|'document'|'request';message:string} } | { state: 'complete'; key: string }>;
  finish(name: string, key: string, completion?: StageCompletion): Promise<void>;
  fail(name: string, error:{code:string;kind:'blocker'|'document'|'request';message:string}): Promise<void>;
}
export async function checkpoint(store: CheckpointStore, guard: () => Promise<void>, name: string,
  work: () => Promise<string | StageResult>): Promise<string> {
  await guard();
  const claim = await store.claim(name);
  if (claim.state === 'complete') return claim.key;
  if (claim.state === 'uncertain') throw new ServerFailure('E_STEP_UNCERTAIN', 'blocker', serverCopy.checkpointUncertain);
  if (claim.state === 'failed') throw new ServerFailure(claim.error.code, claim.error.kind, claim.error.message);
  let result: string | StageResult;
  try {
    // Ownership of a reconciled claim is not permission to begin work after a kill or closure.
    await guard();
    result = await work();
  } catch (error) {
    const issue = failure(error);
    try {
      await store.fail(name, { code: issue.code, kind: issue.kind, message: issue.message });
    } catch (persistenceError) {
      const unconfirmed = new ServerFailure('E_CHECKPOINT_FAIL', 'blocker', serverCopy.checkpointFailureUnconfirmed);
      unconfirmed.cause = new AggregateError([error, persistenceError], 'The work failed and its failure record could not be confirmed.');
      throw unconfirmed;
    }
    // The owned failure record is confirmed: preserve the exact original typed work error.
    throw error;
  }
  // Work already returned its durable key. An unverified finishing write is never a new work failure.
  const key = typeof result === 'string' ? result : result.key;
  await store.finish(name, key, typeof result === 'string' ? undefined : result.completion);
  return key;
}
