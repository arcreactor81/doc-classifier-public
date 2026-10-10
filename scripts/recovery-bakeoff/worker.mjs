import {createEvaluationWorker} from '../reader-bakeoff/worker.mjs';
import {normalizeRecoveryManifest,recoveryAdapter} from './runtime-contract.mjs';
/** Same durable executor, tables, global spending and unknown-usage gate as readers. */
export function createRecoveryWorker(frozenManifest){return createEvaluationWorker(normalizeRecoveryManifest(frozenManifest),recoveryAdapter);}
