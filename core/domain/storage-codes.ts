/**
 * DECISIONS 135: the failure codes of a document's own storage outcomes that the bounded retries could not confirm. In
 * that document's Workflow they set the document aside as could_not_process instead of halting the run (see
 * core/server/execution.ts `Runner.containStorageFailure`). Run-level state (the run row, controls, run lifecycle, the
 * vendor circuit, provider cooldowns, native-runtime receipts) and the document's own outcome record are not here: they
 * still halt. An unconfirmable charge is not here either (core/server/errors.ts `CHARGE_STORAGE_CODES`).
 *
 * The one list for both sides: the server builds `DOCUMENT_STORAGE_CODES` from it (core/server/errors.ts), and the
 * browser uses it to put these documents into the new run from a stopped run (core/ui/new-run-documents.ts; DECISIONS
 * 135 addendum of 7 October 2026). No I/O, no imports, so the browser never imports from core/server.
 *
 * The runtime codes (DECISIONS 144, 8 October 2026) are set aside on the same rule, count toward the storage brake, and
 * go into the new run; nothing was wrong with the document itself. `E_RUNTIME_WAIT_LIMIT`: the platform interrupted the
 * document's Workflow step the recorded number of times (core/server/runtime-interruption.ts RUNTIME_INTERRUPTION_LIMIT).
 * `E_RUNTIME_WAIT_EXPIRED`: an interrupted document was not resumed within its recorded waiting window (RUNTIME_WAIT_MS);
 * `E_RUNTIME_TERMINAL`: the Workflow engine reported the document's instance as ended before any outcome of ours. Both
 * are settled on the document's behalf by whoever observes them (core/server/runtime-settlement.ts).
 * `E_DISPATCH_UNCONFIRMED` (review of 8 October 2026, finding 3): Cloudflare never confirmed that the document's
 * Workflow had started, so nothing was sent for it; it is set aside at dispatch (core/server/workflow-create.ts).
 */
export const DOCUMENT_STORAGE_FAILURE_CODES: readonly string[] = Object.freeze([
  'E_ARTIFACT_WRITE', 'E_ARTIFACT_EXISTS', 'E_ARTIFACT_MISSING', 'E_STORAGE_READ', 'E_CHECKPOINT_CLAIM', 'E_CHECKPOINT_FINISH',
  'E_CHECKPOINT_FAIL', 'E_STEP_UNCERTAIN', 'E_EVENT_PERSISTENCE', 'E_DOCUMENT_WRITE', 'E_RUNTIME_WAIT_LIMIT',
  'E_RUNTIME_WAIT_EXPIRED', 'E_RUNTIME_TERMINAL', 'E_DISPATCH_UNCONFIRMED'
]);
