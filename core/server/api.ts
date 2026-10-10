import { bakeoffOf, createBakeoff, currentBakeoffBaseline, readBakeoffView } from './bakeoff.ts';
import { readUsageSummary } from './usage-summary.ts';
import {
  readStoredCorrection, saveReference, readReference, comparisonForRun,
  carryReference
} from './feedback.ts';
import {
  effectiveProject, definitionState, createDefinitionDraft, activateDefinition, requireEditor,
  runtimeDefinitions, activeDefinition
} from './definitions.ts';
import { dispatchRunDocuments } from './start-dispatch.ts';
import { extractorMixPlan } from './extractor-mix.ts';
import { documentPhase } from './document-phase.ts';
import { readRunStopReason } from './run-stop.ts';
import {
  readRunStatusInput, readLastUploadAt, readComparedWith, frozenDefinitionRevisionId, campaignOf, pilotSkippedOf
} from './run-status-read.ts';
import { runStatusResponse, requestedVersion } from '../domain/run-status.ts';
import { closeNeedsDiscard, confirmsDiscard } from './closure.ts';
import { documentEvidence } from './document-evidence.ts';
import { workflowInstanceId } from './workflow-identity.ts';
import {
  requireProject, typeVersion, type ProjectPack
} from '../config/project.ts';
import { appliedThresholdStatus } from '../config/definitions.ts';
import { readRunBudget } from '../cost/run-budget.ts';
import type { CorrectionProposals } from '../correction/proposals.ts';
import { actorFor } from './auth.ts';
import { health, projectSource, requireReady } from './health.ts';
import { Store, now, shaText, spendFromRow, unknownFromRow, type RunRow } from './store.ts';
import {
  object, requireValue, exact, jsonBody,
  readOptionalJson
} from './contracts.ts';
import { ServerFailure, serverCopy, failure, failureResponse } from './errors.ts';
import { runPlan, quote, createRun, uploadDocument } from './intake.ts';
import { manifestFor, compactResults, resultPages } from './results.ts';
import { corrections } from './corrections.ts';
import { pilotReview, pilotConfirm, pilotView } from './pilot.ts';
import { runVendors } from '../vendors/outbound.ts';
import { observeRuntime, readRuntimeWait } from './runtime-observation.ts';
import { enforceRuntimeDeadline } from './runtime-settlement.ts';
import { guard } from './execution.ts';
import { associateAcceptedWorkflow, persistRunStart, persistRunCompletion } from './run-persistence.ts';
import { haltTrippedRun } from './circuit-persistence.ts';
import { createDocumentWorkflow } from './workflow-create.ts';
import { setEmergencyStop } from './emergency-stop.ts';
import { requireBakeoffExecution } from './bakeoff-execution.ts';
import { applyReaderThreshold } from './model-calibration.ts';
import { requireReaderReady } from './reader-readiness.ts';
import { recordReaderVersion } from './reader-version.ts';

export function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}

async function authorizeRun(store: Store, id: string, actor: string): Promise<RunRow> {
  const run = await store.run(id);
  if (run.actor !== actor) throw new ServerFailure('E_RUN_FORBIDDEN', 'request',
    'This run belongs to a different signed-in person.', 403);
  return run;
}

async function start(
  env: Env,
  store: Store,
  run: RunRow,
  authentication: 'legacy' | 'cloudflare'
): Promise<Response> {
  run = await store.run(run.id);
  if (!['uploading', 'running'].includes(run.status))
    return response({ started: 0, pending: 0, status: run.status });
  if (run.status === 'running' && run.runtime_pending_deadline_ms !== null && run.runtime_pending_deadline_ms <= Date.now()) {
    await enforceRuntimeDeadline(store, run.id);
    run = await store.run(run.id);
    if (run.status !== 'running') return response({ started: 0, pending: 0, status: run.status });
  }
  await requireReady(env, authentication);
  await requireBakeoffExecution(env, store, run);
  // DECISIONS 136, addendum item 4: the backstop behind the greyed-out menu. A reader that became unusable after the run
  // was created is refused here, as at the quote and run creation, before anything is dispatched.
  await requireReaderReady(env, JSON.parse(run.pack_json) as ProjectPack);
  const docs = await store.documents(run.id);
  requireValue(docs.length === run.expected_count,
    'Every document must be uploaded before starting.');
  if (run.status === 'uploading') {
    // v3 records a version mix once on the run (flagged, not blocking); frozen v1/v2 runs keep the
    // historical per-document note, which sends every document to review.
    const mix = extractorMixPlan(docs.map(doc => doc.extractor_version),
      requireProject(JSON.parse(run.pack_json)).settings.decisionNotePolicy);
    if (mix.runNotes.length) {
      // Added to the notes the run already carries (for example the note recorded at creation), never in their place.
      const existing = JSON.parse(run.notes_json) as string[];
      await env.DB.prepare('UPDATE runs SET notes_json=? WHERE id=?')
        .bind(JSON.stringify([...new Set([...existing, ...mix.runNotes])]), run.id).run();
      await store.event(run.id, null, 'start', 'extractor_versions_mixed', { versions: mix.versions });
    }
    if (mix.documentNotes.length)
      for (const doc of docs)
        await env.DB.prepare('UPDATE documents SET notes_json=? WHERE run_id=? AND fingerprint=?')
          .bind(JSON.stringify(mix.documentNotes), run.id, doc.fingerprint).run();
    // Owner decision of 7 October 2026: a DeepSeek run records the version DeepSeek lists, once, at its first Start.
    // A record, never a gate: a list that cannot be read is recorded as not known and the run starts as before.
    await recordReaderVersion(env, store, run);
    await persistRunStart(env.DB, run);
  }
  return response(await dispatchRunDocuments({
    readStatus: async () => {
      let current = await store.run(run.id);
      if (current.status === 'running' && current.runtime_pending_deadline_ms !== null && current.runtime_pending_deadline_ms <= Date.now()) {
        await enforceRuntimeDeadline(store, run.id);
        current = await store.run(run.id);
      }
      return current.status;
    },
    readDocuments: () => store.documents(run.id),
    create: async (fingerprint, control) => {
      const document = docs.find(candidate => candidate.fingerprint === fingerprint);
      if (!document) throw new ServerFailure('E_RUN_PERSISTENCE', 'blocker', serverCopy.runPersistenceUnconfirmed);
      const inputHash = document.input_hash;
      const id = await workflowInstanceId(run.id, fingerprint);
      // A sibling can stop dispatch while the identity hash is being computed.
      if (control.stopped()) return false;
      let accepted = false, guardFailed = false;
      try {
        const result = await createDocumentWorkflow(store, { runId: run.id, fingerprint, inputHash, workflowId: id }, run, async () => {
          if (control.stopped()) return false;
          try { await guard(env, store, run.id); }
          catch (error) {
            guardFailed = true; control.stop();
            const issue = failure(error);
            if (issue.code !== 'E_RUN_STOPPED' && issue.code !== 'E_RUNTIME_WAIT_EXPIRED')
              await store.halt(run.id, { code: issue.code, message: issue.message });
            throw error;
          }
          return !control.stopped();
        });
        // A document set aside at dispatch (review of 8 October 2026, finding 3) has no Workflow identity: nothing to
        // associate, nothing started; its peers go on.
        if (result === 'stopped' || result === 'set_aside') return false;
        accepted = true;
        const associated = await associateAcceptedWorkflow(env.DB, { runId: run.id, fingerprint, inputHash, workflowId: id });
        if (associated === 'set_aside') return false;
        return result === 'created';
      }
      catch (error) {
        if (guardFailed) throw error;
        // Stop peer submissions immediately; D1 halt/event persistence may itself be delayed or fail.
        control.stop();
        await store.halt(run.id, {
          code: accepted ? 'E_WORKFLOW_ASSOCIATION' : 'E_WORKFLOW_START',
          detail: failure(error).message
        });
        if (accepted) throw error;
        throw new ServerFailure('E_WORKFLOW_START', 'blocker',
          'A document workflow could not be started. The run has halted.');
      }
    },
    markComplete: async () => {
      if (await persistRunCompletion(env.DB, run.id)) await store.reconcileSpend(run.id);
      // DECISIONS 140 (a): completion refuses a run with a recorded storage-brake trip; stop it instead of leaving it running.
      else await haltTrippedRun(store, run.id);
    },
  }));
}

/**
 * Headers on every response the Worker returns: the app's pages (the ASSETS binding runs behind the Worker,
 * `run_worker_first`) and every API answer. No other site may frame the app (clickjacking), the browser never guesses a
 * content type, and no address leaves the site as a referrer. Cloudflare Access's sign-in pages are its own, on another
 * host, and are not touched. A header the response already sets is kept.
 */
const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ['content-security-policy', "frame-ancestors 'none'"],
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'same-origin']
];

function withSecurityHeaders(answer: Response): Response {
  const headers = new Headers(answer.headers);
  for (const [name, value] of SECURITY_HEADERS) if (!headers.has(name)) headers.set(name, value);
  // A fetched answer's headers are immutable (the ASSETS binding's are), so the response is rebuilt around the same body.
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

export async function handle(request: Request, env: Env & { ASSETS?: Fetcher }): Promise<Response> {
  return withSecurityHeaders(await handleRequest(request, env));
}

// Test and local-acceptance entry; no deployed Worker exports it. The caller supplies the actor, and 'cloudflare'
// authentication skips the Access settings check those environments cannot satisfy. No request field selects it.
export async function handleWithCloudflareIdentity(
  request: Request,
  env: Env,
  actor: string
): Promise<Response> {
  if (!actor) return withSecurityHeaders(response(failureResponse(
    new ServerFailure('E_ACCESS_REQUIRED', 'request', 'Sign in to continue.', 401)
  ), 401));
  return withSecurityHeaders(await handleRequest(request, env, actor));
}

async function handleRequest(
  request: Request,
  env: Env & { ASSETS?: Fetcher },
  cloudflareActor?: string
): Promise<Response> {
  try {
    const url = new URL(request.url), path = url.pathname;
    const authentication = cloudflareActor ? 'cloudflare' : 'legacy';
    if (path === '/api/health' && request.method === 'GET') return response(await health(env, authentication));
    if (path === '/api/project' && request.method === 'GET')
      return response(await effectiveProject(env, projectSource, url.searchParams.has('selectedReaderModel')
        ? { selectedReaderModel: url.searchParams.get('selectedReaderModel')! } : undefined));
    if (!path.startsWith('/api/'))
      return env.ASSETS ? await env.ASSETS.fetch(request) : new Response(null, { status: 404 });
    const actor = cloudflareActor ?? await actorFor(request, env), store = new Store(env);
    if (path === '/api/usage' && request.method === 'GET')
      return response(await readUsageSummary(env, await effectiveProject(env, projectSource), actor));
    if (path === '/api/bakeoffs/baseline' && request.method === 'GET') {
      const baseline = await currentBakeoffBaseline(env);
      return response({ baseline, baselineHash: await shaText(JSON.stringify(baseline)) });
    }
    if (path === '/api/bakeoffs' && request.method === 'POST')
      return response(await createBakeoff(store, actor, await jsonBody(request)), 201);
    const bakeoffRead = /^\/api\/bakeoffs\/([^/]+)$/.exec(path);
    if (bakeoffRead && request.method === 'GET')
      return response(await readBakeoffView(store, bakeoffRead[1], actor));
    if (path === '/api/definitions' && request.method === 'GET')
      return response(await definitionState(env, projectSource as ProjectPack, actor));
    if (path === '/api/definitions/drafts' && request.method === 'POST')
      return response(await createDefinitionDraft(
        env, projectSource as ProjectPack, actor, await jsonBody(request)
      ), 201);
    const activation = /^\/api\/definitions\/([^/]+)\/activate$/.exec(path);
    if (activation && request.method === 'POST')
      return response(await activateDefinition(
        env, projectSource as ProjectPack, actor, activation[1], await jsonBody(request)
      ));
    const feedbackRead = /^\/api\/feedback\/([^/]+)$/.exec(path);
    if (feedbackRead && request.method === 'GET')
      return response(await readReference(store, feedbackRead[1], actor));
    // Explicit owner action: carry confirmed labels, unchanged, to the active category version.
    const feedbackCarry = /^\/api\/feedback\/([^/]+)\/carry$/.exec(path);
    if (feedbackCarry && request.method === 'POST') {
      const raw = await jsonBody(request);
      requireValue(object(raw), 'Confirm carrying these labels.');
      exact(raw, []);
      requireValue(runtimeDefinitions(env), 'Carrying labels needs website category editing.');
      const active = await activeDefinition(env);
      return response(await carryReference(store, feedbackCarry[1], actor, active?.id ?? null), 201);
    }
    if (path === '/api/quote' && request.method === 'POST')
      return await quote(request, env, store, actor, authentication);
    if (path === '/api/runs' && request.method === 'POST')
      return await createRun(request, env, store, actor, authentication);
    if (path === '/api/runs' && request.method === 'GET') {
      const rows = (await env.DB.prepare(
        'SELECT * FROM runs WHERE actor=? ORDER BY created_at DESC'
      ).bind(actor).all<RunRow>()).results;
      const runs = [];
      for (const run of rows) {
        // Step 3: counts from COUNT queries and spend from the run's counters; no document or vendor_calls scan per run.
        const counts = await store.runCounts(run.id), spend = spendFromRow(run);
        runs.push({
          id: run.id,
          status: run.status,
          createdAt: run.created_at,
          total: run.expected_count,
          completed: counts.completed,
          spendNano: spend.blended,
          spend,
          budget: readRunBudget(JSON.parse(run.budget_json)),
          unaccountedCalls: unknownFromRow(run),
          pendingAccounting: await store.pendingAccounting(run.id),
          runtimeWait: await readRuntimeWait(store, run),
          textHeld: !!run.text_held,
          mode: run.mode,
          // S4: what Home and the Runs list show without opening every run.
          uploaded: counts.uploaded,
          lastUploadAt: await readLastUploadAt(env, run.id),
          definitionRevisionId: frozenDefinitionRevisionId(run),
          comparedWith: await readComparedWith(env, run.id),
          // Step 4: the pilot campaign this run belongs to, so Home can pair a pilot with its full run.
          campaign: campaignOf(run),
          // Present only for a run made under a pretend-vendor build (its run-level note says so).
          ...runVendors(JSON.parse(run.notes_json) as string[]),
          // Present only for a run the person started without a pilot (DECISIONS 88).
          ...pilotSkippedOf(run),
          ...bakeoffOf(run)
        });
      }
      return response({ runs });
    }
    if (path === '/api/kill' && request.method === 'POST') {
      const raw = await jsonBody(request);
      requireValue(object(raw), 'An explicit switch state is required.');
      exact(raw, ['enabled']);
      requireValue(typeof raw.enabled === 'boolean', 'An explicit switch state is required.');
      return response(await setEmergencyStop(env, store, actor, raw.enabled));
    }
    const match = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match)
      throw new ServerFailure('E_ROUTE', 'request', 'This API route does not exist.', 404);
    const run = await authorizeRun(store, match[1], actor), action = match[2];
    if (!action && request.method === 'GET') {
      // ?events=0 lets a polling client skip the full event history; phases come from checkpoints.
      const withEvents = url.searchParams.get('events') !== '0';
      const documents = await store.documents(run.id),
        spend = await store.spendByVendor(run.id),
        events = withEvents
          ? (await env.DB.prepare('SELECT * FROM events WHERE run_id=? ORDER BY created_at')
            .bind(run.id).all()).results
          : [],
        checkpoints = (await env.DB.prepare(
          'SELECT fingerprint,name,status FROM checkpoints WHERE run_id=?'
        ).bind(run.id).all<{ fingerprint: string; name: string; status: string }>()).results;
      const byDocument = new Map<string, { name: string; status: string }[]>();
      for (const checkpoint of checkpoints)
        byDocument.set(checkpoint.fingerprint,
          [...(byDocument.get(checkpoint.fingerprint) ?? []), checkpoint]);
      return response({
        run: {
          id: run.id,
          status: run.status,
          createdAt: run.created_at,
          total: run.expected_count,
          completed: documents.filter(doc => doc.status === 'complete').length,
          mode: run.mode,
          textHeld: !!run.text_held,
          spendNano: spend.blended,
          spend,
          budget: readRunBudget(JSON.parse(run.budget_json)),
          unaccountedCalls: await store.unaccounted(run.id),
          pendingAccounting: await store.pendingAccounting(run.id),
          threshold: run.threshold,
          notes: JSON.parse(run.notes_json) as string[],
          stopReason: await readRunStopReason(store, run),
          runtimeWait: await readRuntimeWait(store, run),
          ...runVendors(JSON.parse(run.notes_json) as string[]),
          ...pilotSkippedOf(run),
          ...bakeoffOf(run)
        },
        documents: documents.map(doc => ({
          ...doc,
          decision: doc.decision_json ? JSON.parse(doc.decision_json) : null,
          phase: documentPhase(doc.status, byDocument.get(doc.fingerprint) ?? [])
        })),
        events
      });
    }
    // S1: the compact status a polling client reads; `?version=` returns `unchanged` when nothing moved. Reads only, with one
    // exception (DECISIONS 140 (a)): a run still running with every document decided and a recorded storage-brake trip lost
    // its stop, and this poll makes it. Only that state costs one more read; the stop is idempotent and keeps the first cause.
    if (action === 'status' && request.method === 'GET') {
      let input = await readRunStatusInput(store, env, run, Date.now());
      if (input.run.status === 'running' && input.documents.length === run.expected_count &&
          input.documents.every(document => document.status === 'complete') && await haltTrippedRun(store, run.id))
        input = await readRunStatusInput(store, env, await store.run(run.id), Date.now());
      return response(runStatusResponse(input, requestedVersion(url.searchParams.get('version'))));
    }
    if (action === 'observe-runtime' && request.method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new ServerFailure('E_ORIGIN', 'request',
        'The request must come from this application.', 403);
      const raw = await jsonBody(request);
      requireValue(object(raw), 'An empty observation request is required.');
      exact(raw, []);
      return response(await observeRuntime(store, run.id));
    }
    const evidence = /^documents\/([^/]+)\/evidence$/.exec(action ?? '');
    if (evidence && request.method === 'GET')
      return response(await documentEvidence(store, run.id, evidence[1], actor));
    if (action === 'documents' && request.method === 'POST')
      return await uploadDocument(request, env, store, run);
    if (action === 'start' && request.method === 'POST')
      return await start(env, store, run, authentication);
    if (action === 'close' && request.method === 'POST') {
      // S3: closing an unfinished run discards it for ever (no results file), so it must be confirmed explicitly.
      // Finished runs, and closures already under way, keep today's contract.
      if (closeNeedsDiscard(run.status) && !confirmsDiscard(await readOptionalJson(request)))
        throw new ServerFailure('E_CLOSE_UNFINISHED', 'blocker',
          'This run hasn’t finished. Closing it now discards it: it will never have a results file.');
      return response(await store.close(run.id, actor));
    }
    // Step 3: the compact results (what Results and Review load) and full entries in pages (what Build and
    // "Save a copy" stream). Additive beside `results` and `manifest`, which keep today's full shape.
    if (action === 'results/compact' && request.method === 'GET')
      return response(await compactResults(store, run));
    if (action === 'results/pages' && request.method === 'GET')
      return response(await resultPages(store, run,
        { after: url.searchParams.get('after'), limit: url.searchParams.get('limit') }));
    if (action === 'results' && request.method === 'GET')
      return response(await manifestFor(store, run));
    if (action === 'plan' && request.method === 'GET')
      return response(await runPlan(store, run));
    // Downloading the results file never closes the run or deletes text; only POST .../close does.
    if (action === 'manifest' && request.method === 'GET') {
      const manifest = await manifestFor(store, run);
      return new Response(JSON.stringify(manifest, null, 2), {
        headers: {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename="${run.id}-manifest.json"`,
          'cache-control': 'no-store'
        }
      });
    }
    // Step 4: the pilot review. A person marks every document the pilot filed right or wrong and then confirms;
    // only that recorded confirmation lets a full run above the pilot size be quoted (never a computed result).
    if (action === 'pilot' && request.method === 'GET')
      return response(await pilotView(env, store, run));
    if (action === 'pilot-review' && request.method === 'POST')
      return await pilotReview(request, env, store, run, actor);
    if (action === 'pilot-confirmation' && request.method === 'POST')
      return await pilotConfirm(request, env, store, run, actor);
    if (action === 'corrections' && request.method === 'GET') {
      const rows = (await env.DB.prepare(
        'SELECT id,created_at FROM corrections WHERE run_id=? ORDER BY created_at DESC'
      ).bind(run.id).all<{ id: string; created_at: string }>()).results;
      return response({
        corrections: rows.map(row => ({ id: row.id, createdAt: row.created_at }))
      });
    }
    if (action === 'corrections' && request.method === 'POST')
      return await corrections(request, env, store, run, actor);
    const savedCorrection = /^corrections\/([^/]+)$/.exec(action ?? '');
    if (savedCorrection && request.method === 'GET')
      return response(await readStoredCorrection(store, run, savedCorrection[1]));
    const referenceSave = /^corrections\/([^/]+)\/reference$/.exec(action ?? '');
    if (referenceSave && request.method === 'POST') return response(await saveReference(
      store,
      run,
      referenceSave[1],
      actor,
      await jsonBody(request) as Parameters<typeof saveReference>[4]
    ), 201);
    if (action === 'comparison' && request.method === 'GET')
      return response(await comparisonForRun(store, run, actor));
    const apply = /^corrections\/([^/]+)\/apply$/.exec(action ?? '');
    if (apply && request.method === 'POST') {
      requireEditor(env, actor);
      const active = runtimeDefinitions(env) ? await activeDefinition(env) : null;
      const frozen = JSON.parse(run.pack_json) as ProjectPack;
      requireValue(!runtimeDefinitions(env) || active !== null,
        'Activate categories before applying a threshold.');
      requireValue(
        active
          ? active.id === frozen.definitionRevisionId
          : run.type_version ===
            await typeVersion(JSON.stringify(requireProject(projectSource).typeFile)),
        'These corrections belong to a different category version.'
      );
      const raw = await jsonBody(request);
      requireValue(object(raw), 'A threshold decision is required.');
      exact(raw, ['direction', 'threshold']);
      requireValue(raw.direction === 'raise' || raw.direction === 'lower',
        'Select a stored proposal.');
      const correction = await env.DB.prepare(
        'SELECT proposals_json FROM corrections WHERE id=? AND run_id=?'
      ).bind(apply[1], run.id).first<{ proposals_json: string }>();
      requireValue(correction, 'The correction does not exist.');
      const proposal =
        (JSON.parse(correction.proposals_json) as CorrectionProposals)[raw.direction];
      requireValue(proposal && proposal.threshold === raw.threshold,
        'Only the exact stored threshold proposal may be applied.');
      // S6: a repeated Apply of the same suggestion is refused plainly, before either write could collide with
      // UNIQUE(correction_id, direction) and surface as an internal error.
      const applied = await env.DB
        .prepare('SELECT 1 FROM threshold_history WHERE correction_id=? AND direction=?')
        .bind(apply[1], raw.direction)
        .first();
      if (applied)
        throw new ServerFailure('E_THRESHOLD_ALREADY_APPLIED', 'blocker', 'This suggestion has already been applied.');
      if (frozen.readerModels !== undefined || (projectSource as ProjectPack).readerModels !== undefined)
        return response(await applyReaderThreshold(env.DB, frozen, { runId: run.id, typeVersion: run.type_version },
          { correctionId: apply[1], actor, threshold: raw.threshold as number, direction: raw.direction }));
      if (active) {
        const thresholdStatus = appliedThresholdStatus(
          {
            threshold: active.threshold,
            status: active.thresholdStatus,
            justification: active.thresholdJustification
          },
          { threshold: raw.threshold, correctionId: apply[1] }
        );
        // Compare-and-set against the row just read, so two concurrent applies cannot both confirm.
        const changed = await env.DB.batch([
          env.DB.prepare(
            'UPDATE definition_active SET threshold=?,threshold_status=?,justification=? WHERE id=1 AND revision_id=? AND threshold=? AND threshold_status=? AND justification=?'
          ).bind(
            raw.threshold,
            thresholdStatus,
            apply[1],
            active.id,
            active.threshold,
            active.thresholdStatus,
            active.thresholdJustification
          ),
          env.DB.prepare(
            'INSERT INTO threshold_history(id,correction_id,actor,created_at,threshold,direction) SELECT ?,?,?,?,?,? WHERE changes()=1'
          ).bind(crypto.randomUUID(), apply[1], actor, now(), raw.threshold, raw.direction)
        ]);
        requireValue(changed[0].meta.changes === 1,
          'Categories changed before this threshold could be applied.');
        return response({
          applied: true,
          threshold: raw.threshold,
          thresholdStatus,
          correctionId: apply[1]
        });
      }
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO threshold_history(id,correction_id,actor,created_at,threshold,direction) VALUES(?,?,?,?,?,?)'
        ).bind(crypto.randomUUID(), apply[1], actor, now(), raw.threshold, raw.direction),
        env.DB.prepare('UPDATE controls SET threshold=?,threshold_justification=? WHERE id=1')
          .bind(raw.threshold, apply[1])
      ]);
      return response({ applied: true, threshold: raw.threshold, correctionId: apply[1] });
    }
    throw new ServerFailure('E_ROUTE', 'request', 'This API route does not exist.', 404);
  } catch (error) {
    const issue = failure(error);
    return response(failureResponse(issue), issue.status);
  }
}
