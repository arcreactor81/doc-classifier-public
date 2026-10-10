import { sumVendorSpend, type Spend } from '../cost/run-budget.ts';
import { persistVendorCall, type VendorCall, type VendorCallCompletion } from './vendor-call-persistence.ts';
import type { CheckpointStore } from './checkpoint.ts';
import { appendEvent, type PersistedEvent } from './event-persistence.ts';
import { checkpointPersistence } from './checkpoint-persistence.ts';
import { persistRunHalt } from './run-persistence.ts';
import { ServerFailure, serverCopy, failure } from './errors.ts';
import { reconcileTextWrites, closureRefusal, refusedRule } from './closure.ts';
import { registerArtifact, completeArtifact, type ArtifactRegistration, type ArtifactRecovery } from './artifact-persistence.ts';
import { readD1, D1_WRITE_ATTEMPTS, classifyD1WriteTransient, retryTransientRead } from './d1-write-policy.ts';
import { persistTextDeletion, deleteClosedText, TEXT_DELETION_D1_QUERY_BOUND, closureDiagnostic } from './text-deletion-persistence.ts';
import { persistClosureTransition, CLOSURE_TRANSITION_D1_QUERY_BOUND } from './closure-transition.ts';
import { storageCircuitTrippedSql } from './circuit-persistence.ts';
import { classifyR2Transient, ownsStoredObject, readR2, r2Backoff, R2_ATTEMPTS, type StoredIdentity } from './r2-write-policy.ts';

/**
 * At most this many text artifacts are deleted per close call, including reconciled pending writes. Healthy objects
 * use one R2 delete plus one D1 update. Retry-heavy pages stop sooner under the separate D1 invocation query budget.
 */
export const CLOSE_PAGE = 400;
/** D1 still documents 1,000 queries/invocation on Paid; the general Workers Paid subrequest limit is 10,000 (9 Oct 2026). */
const CLOSE_D1_QUERY_LIMIT = 1_000;
/** Held back beyond every counted bound, so a query the arithmetic missed cannot reach the platform limit (9 Oct 2026 review). */
const CLOSE_D1_SPARE = 40;
const CLOSE_EVENT_D1_BOUND = D1_WRITE_ATTEMPTS * (1 + D1_WRITE_ATTEMPTS);
// Ownership read + close's run read + closing UPDATE + requested event + pending/page SELECTs.
const CLOSE_INITIAL_D1_BOUND = 4 * D1_WRITE_ATTEMPTS + CLOSURE_TRANSITION_D1_QUERY_BOUND + CLOSE_EVENT_D1_BOUND;
// Reconciliation: run read, two scans, notes UPDATE, drift event and (if it fails) reconcile_failed event.
const CLOSE_SPEND_D1_BOUND = D1_WRITE_ATTEMPTS + 3 + 2 * CLOSE_EVENT_D1_BOUND;
// Pending count, final count/page event, closed UPDATE/completed event, spend reconciliation and failure diagnostic.
const CLOSE_FINAL_D1_BOUND = 2 * D1_WRITE_ATTEMPTS + CLOSURE_TRANSITION_D1_QUERY_BOUND + 3 * CLOSE_EVENT_D1_BOUND + CLOSE_SPEND_D1_BOUND;
const CLOSE_DATA_D1_BUDGET = CLOSE_D1_QUERY_LIMIT - CLOSE_INITIAL_D1_BOUND - CLOSE_FINAL_D1_BOUND - CLOSE_D1_SPARE;
const CLOSE_PENDING_UNIT_D1_BOUND = TEXT_DELETION_D1_QUERY_BOUND + CLOSE_EVENT_D1_BOUND;
export const CLOSE_PENDING_PAGE = Math.min(CLOSE_PAGE, Math.floor(CLOSE_DATA_D1_BUDGET / CLOSE_PENDING_UNIT_D1_BOUND));
/** The most D1 queries one close call can make when every bound is spent: initial reserve, data budget, final reserve (960). */
export const CLOSE_WORST_CASE_D1_QUERIES = CLOSE_INITIAL_D1_BOUND + CLOSE_DATA_D1_BUDGET + CLOSE_FINAL_D1_BOUND;

export interface RunRow {
  id: string;
  actor: string;
  status: string;
  created_at: string;
  closed_at: string | null;
  mode: 'interactive' | 'batch';
  expected_count: number;
  threshold: number;
  threshold_justification: string;
  type_version: string;
  pack_json: string;
  budget_json: string;
  text_held: number;
  manifest_key: string | null;
  halt_json: string | null;
  quote_id: string;
  /** Absent on ordinary and historical runs; immutable experiment provenance when present. */
  bakeoff_json?: string | null;
  /** Run-level notes (migration 0010), e.g. N_EXTRACTOR_VERSION_MIXED under note policy v4 (v3 for runs before 1 October 2026). */
  notes_json: string;
  /**
   * The campaign this run belongs to (migration 0014): a pilot run and the full run(s) that follow it on the same
   * category version (owner decision, 25 September 2026). Null for runs made before the pilot step existed.
   */
  campaign_id: string | null;
  /** The run's part in its campaign (migration 0019); null exactly when `campaign_id` is null. */
  campaign_role: 'pilot' | 'full' | null;
  /**
   * 1 when the person chose to start this run without a pilot (migration 0020; DECISIONS 88), otherwise 0. Written once
   * at creation beside the run-level note `N_PILOT_SKIPPED`; such a run has no campaign and no pilot review.
   */
  pilot_skipped: number;
  /**
   * Per-run spend counters (migration 0016), kept in the same D1 batch as each vendor_calls insert so the spending guard
   * reads one row instead of every call. Integers in nanodollars; exact to 2^53 (about $9M per run) because D1 returns
   * INTEGER as a JS number. `unknown_calls` counts calls whose cost is unknown (cost_nano null).
   */
  spend_openai_nano: number;
  spend_typesafe_nano: number;
  unknown_calls: number
  /** Earliest unresolved runtime interruption, maintained atomically with the per-document receipts. */
  runtime_pending_deadline_ms: number | null;
}

export interface DocumentRow {
  run_id: string;
  fingerprint: string;
  tag: string;
  original_filename: string;
  status: string;
  input_key: string | null;
  input_hash: string;
  extractor_version: string | null;
  workflow_id: string | null;
  digest_key: string | null;
  confidence_key: string | null;
  reader_key: string | null;
  notes_json: string;
  decision_json: string | null;
  failure_json: string | null;
  extraction_json: string | null;
  /** The document's position in its quote, 1-based (migration 0015; backfilled from the tag for older runs). The paging key. */
  ordinal: number | null;
  /**
   * Written at decision time for new runs (migration 0017): `{choice, certainty, noul, readerYes}` so that results and
   * corrections need no model-output reads. Null for runs decided before it existed; readers fall back to the stored outputs.
   */
  summary_json: string | null;
  runtime_entry_token: string | null;
  runtime_entry_sequence: number;
}

export const now = () => new Date().toISOString();

/** Run-level note recorded once when the spend counters and the full `vendor_calls` scan disagree at complete/halted. */
export const SPEND_LEDGER_DRIFT_NOTE = 'N_SPEND_LEDGER_DRIFT';

type SpendCounters = Pick<RunRow, 'spend_openai_nano' | 'spend_typesafe_nano'>;

/**
 * Exactness bound, stated once: the counters are SQLite INTEGERs that D1 returns as JS numbers, so they are exact up to
 * 2^53 nanodollars (about $9M per run). A value at or beyond that, or anything that is not a nonnegative integer, is
 * refused loudly rather than read approximately.
 */
function counter(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ServerFailure(
    'E_SPEND_COUNTER_RANGE',
    'blocker',
    `The run counter ${name} is outside the exact range or not an integer.`
  );
  return value;
}

/** Known spend in the shape the spending guard and every reader use, from the run's counters. */
export function spendFromRow(run: SpendCounters): Spend {
  const openai = counter(run.spend_openai_nano, 'spend_openai_nano');
  const typesafe = counter(run.spend_typesafe_nano, 'spend_typesafe_nano');
  return {
    blended: (BigInt(openai) + BigInt(typesafe)).toString(),
    openai: String(openai),
    typesafe: String(typesafe)
  };
}

/** Unknown-cost call count from the run's counter. */
export function unknownFromRow(run: Pick<RunRow, 'unknown_calls'>): number {
  return counter(run.unknown_calls, 'unknown_calls');
}

function runNotesOf(run: Pick<RunRow, 'notes_json'>): string[] {
  const notes: unknown = JSON.parse(run.notes_json);
  if (!Array.isArray(notes) || !notes.every(note => typeof note === 'string')) throw new ServerFailure(
    'E_RUN_STATUS_UNREADABLE',
    'blocker',
    'The run notes recorded on this run are unreadable.'
  );
  return notes;
}

export async function shaText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/** The vendor attempt id that HTTP checkpoint `c` records its call under (`…-reader-http-2` ↔ `…-reader-2`). */
const HTTP_ATTEMPT_ID = "c.run_id||'-'||c.fingerprint||'-'||replace(c.name,'-http-','-')";
/** Vendor HTTP checkpoint `c` never completed and its attempt recorded no call row: its charge is unknown. */
export const UNRECEIPTED_HTTP_CHECKPOINT = "c.status!='complete' AND (c.name LIKE 'confidence-http-%' OR c.name LIKE 'reader-http-%' OR c.name LIKE 'recovery-http-%') AND NOT EXISTS(SELECT 1 FROM vendor_calls v WHERE v.attempt_id=" + HTTP_ATTEMPT_ID + ")";

/** The execution guard's single read: the controls row's kill flag and the storage brake's recorded trip beside the full run row. */
export const GUARD_SNAPSHOT_SQL =
  `SELECT k.kill AS guard_kill,r.id IS NOT NULL AS guard_run_present,${storageCircuitTrippedSql('r.id')} AS guard_storage_tripped,r.* FROM (SELECT 1) AS one LEFT JOIN controls k ON k.id=1 LEFT JOIN runs r ON r.id=?`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
}

export class Store {
  readonly env: Env;
  /**
   * Bodies this Store instance itself stored and confirmed, by key. Artifacts are immutable, so a later read of the
   * same key in the same invocation returns these exact bytes without another R2 request. Never shared across
   * invocations: a replay reads R2.
   */
  private readonly written = new Map<string, string>();

  constructor(env: Env) {
    this.env = env;
  }

  async run(id: string): Promise<RunRow> {
    const row = await readD1<RunRow>(this.env.DB
      .prepare('SELECT * FROM runs WHERE id=?')
      .bind(id));
    if (!row) throw new ServerFailure('E_RUN_NOT_FOUND', 'request', 'The run does not exist.', 404);
    return row;
  }

  /**
   * The kill switch, the run row and the storage brake's recorded trip in ONE read, for the execution guard that runs
   * at every step and model boundary.
   * The outer one-row SELECT always returns a row, so a missing controls row and a missing run stay distinguishable.
   */
  async guardSnapshot(runId: string): Promise<{ kill: number | null; run: RunRow | null; storageTripped: boolean }> {
    const row = await readD1(this.env.DB.prepare(GUARD_SNAPSHOT_SQL).bind(runId));
    if (!row) return { kill: null, run: null, storageTripped: false };
    const { guard_kill: kill, guard_run_present: present, guard_storage_tripped: tripped, ...run } = row;
    return { kill: typeof kill === 'number' ? kill : null, run: present === 1 ? run as unknown as RunRow : null, storageTripped: tripped === 1 };
  }

  /** Every document of a run in quote order (`ordinal`, backfilled from the tag for older runs by migration 0015). */
  async documents(id: string): Promise<DocumentRow[]> {
    return (await this.env.DB
      .prepare('SELECT * FROM documents WHERE run_id=? ORDER BY ordinal, tag')
      .bind(id)
      .all<DocumentRow>()).results;
  }

  async document(id: string, fingerprint: string): Promise<DocumentRow> {
    const row = await readD1<DocumentRow>(this.env.DB
      .prepare('SELECT * FROM documents WHERE run_id=? AND fingerprint=?')
      .bind(id, fingerprint));
    if (!row) throw new ServerFailure(
      'E_DOCUMENT_NOT_FOUND',
      'request',
      'The document does not exist in this run.',
      404
    );
    return row;
  }

  async put(
    runId: string | null,
    fingerprint: string | null,
    kind: string,
    value: unknown,
    containsText = false,
    key?: string
  ): Promise<string> {
    const artifactKey = key ??
      `${runId??'system'}/${fingerprint??'run'}/${kind}/${crypto.randomUUID()}.json`;
    const registration: ArtifactRegistration = Object.freeze({ key: artifactKey, runId, fingerprint, kind, containsText,
      createdAt: now(), registrationToken: crypto.randomUUID() });
    const observations: ArtifactRecovery[] = [];
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    // The ledger is written first so a lost response can never leave untracked uploaded text.
    await registerArtifact(this.env.DB, registration, observations);
    let operationFailure: { error: unknown } | undefined;
    try {
      await this.createObject(registration, body, { contentType: 'application/json' });
      try {
        await completeArtifact(this.env.DB, registration, observations);
      } catch (error) {
        // Closure may have released this registration as never written (closure.ts), so completion refuses its deleted
        // row; the text that landed anyway must not outlive the closure. Any other failure is rethrown unchanged.
        if (containsText && runId) await this.discardLateText(runId, artifactKey, error);
        throw error;
      }
      if (containsText && runId) await this.discardLateText(runId, artifactKey);
      this.written.set(artifactKey, body);
      return artifactKey;
    } catch (error) {
      operationFailure = { error }; throw error;
    } finally {
      await this.recordArtifactRecoveries(registration, observations, operationFailure);
    }
  }

  /**
   * Stores a NON-TEXT artifact's object only. Its single ledger row is inserted already complete, by the caller, in the
   * same D1 batch that records the result the object belongs to (a checkpoint finish or a vendor-call receipt), so an
   * object never has a half-written row. Text keeps the register-first path of `put` because closure must see every
   * text write in flight. The put is create-only: an existing object is never replaced.
   */
  async putObject(runId: string, fingerprint: string, kind: string, value: unknown, key?: string): Promise<ArtifactRegistration> {
    return this.storeObject(runId, fingerprint, kind, typeof value === 'string' ? value : JSON.stringify(value),
      key ?? `${runId}/${fingerprint}/${kind}/${crypto.randomUUID()}.json`);
  }

  /** The same for raw vendor bytes held in memory: stored exactly as received. */
  async putObjectBytes(runId: string, fingerprint: string, kind: string, bytes: Uint8Array, key: string): Promise<ArtifactRegistration> {
    return this.storeObject(runId, fingerprint, kind, bytes, key);
  }

  /** JSON text is stored as such and kept for this invocation's own later reads; raw bytes are stored without a type. */
  private async storeObject(runId: string, fingerprint: string, kind: string, body: string | Uint8Array,
    key: string): Promise<ArtifactRegistration> {
    const registration: ArtifactRegistration = Object.freeze({ key, runId, fingerprint, kind, containsText: false,
      createdAt: now(), registrationToken: crypto.randomUUID() });
    const json = typeof body === 'string';
    await this.createObject(registration, body, json ? { contentType: 'application/json' } : undefined);
    if (json) this.written.set(key, body);
    return registration;
  }

  /**
   * One create-only put ('If-None-Match: *'), the object carrying this invocation's registration token and, for bytes
   * held in memory, their SHA-256 (verified and kept by R2). A documented retryable R2 error leaves the outcome
   * uncertain, so the key is read back: this invocation's own object means the put landed; no object means nothing
   * landed and the SAME bytes are sent again, within R2_ATTEMPTS; any other object is another writer's and is never
   * replaced. A stream can be sent only once, so it is confirmed but never re-sent. Unconfirmable outcomes keep the
   * existing failures: E_ARTIFACT_WRITE (with its write_uncertain event), E_ARTIFACT_EXISTS, or the stream's own error.
   */
  private async createObject(registration: ArtifactRegistration, body: string | Uint8Array | ReadableStream<Uint8Array>,
    httpMetadata: R2HTTPMetadata | undefined): Promise<void> {
    const { key, runId, fingerprint } = registration, stream = body instanceof ReadableStream;
    // A string is stored as its UTF-8 bytes, so its identity is computed from exactly those bytes.
    const bytes = stream ? null : typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const identity: StoredIdentity = { registrationToken: registration.registrationToken,
      sha256: bytes ? await sha256Hex(bytes) : null, size: bytes ? bytes.byteLength : null };
    const options: R2PutOptions = { onlyIf: new Headers({ 'If-None-Match': '*' }), ...(httpMetadata ? { httpMetadata } : {}),
      customMetadata: { registrationToken: registration.registrationToken }, ...(identity.sha256 ? { sha256: identity.sha256 } : {}) };
    const exists = () => new ServerFailure('E_ARTIFACT_EXISTS', 'blocker', stream ? 'A raw response artifact already exists.'
      : 'An immutable artifact already exists. It was not overwritten.');
    const uncertain = async (error: unknown): Promise<unknown> => {
      if (stream) return error;
      await this.event(runId, fingerprint, 'artifact', 'write_uncertain', { key });
      const issue = new ServerFailure('E_ARTIFACT_WRITE', 'blocker',
        'The artifact write outcome is uncertain. Its known key remains recorded until completion can be verified.');
      issue.cause = error; return issue;
    };
    const errors: string[] = [];
    const settle = async (error: unknown): Promise<'own' | 'absent'> => {
      let found: R2Object | null;
      try { found = await readR2(() => this.env.ARTIFACTS.head(key), errors); }
      catch (readError) { throw await uncertain(error === null ? readError : new AggregateError([error, readError])); }
      if (found === null) return 'absent';
      if (ownsStoredObject(found, identity)) return 'own';
      throw exists();
    };
    for (let attempt = 1; attempt <= R2_ATTEMPTS; attempt++) {
      let result: R2Object | null;
      try { result = await this.env.ARTIFACTS.put(key, body, options); }
      catch (error) {
        const code = classifyR2Transient(error);
        if (code === null) throw await uncertain(error);
        errors.push(code);
        if (await settle(error) === 'own') { this.observeR2(registration, 'reconciled', attempt, errors); return; }
        if (stream || attempt === R2_ATTEMPTS) throw await uncertain(error);
        await r2Backoff(attempt); continue;
      }
      if (result) { if (errors.length) this.observeR2(registration, 'retried', attempt, errors); return; }
      // A create-only refusal with no earlier uncertainty is another object: never adopted, never replaced.
      if (!errors.length) throw exists();
      // After an uncertain attempt the refusal may be that attempt landing late: prove whose object it is.
      if (await settle(null) === 'own') { this.observeR2(registration, 'reconciled', attempt, errors); return; }
      throw exists();
    }
    throw await uncertain(null);
  }

  /** Content-free diagnostic of a settled R2 uncertainty, like the D1 helpers' (no body, no headers). */
  private observeR2(registration: ArtifactRegistration, outcome: 'retried' | 'reconciled', attempts: number, errors: readonly string[]): void {
    console.log(JSON.stringify({ operation: 'artifact_object_put', outcome, attempts, errors: [...errors],
      runId: registration.runId, fingerprint: registration.fingerprint, key: registration.key }));
  }

  /** A completed event row for a caller's batch: the same frozen identity `event` would write. */
  eventRecord(runId: string | null, fingerprint: string | null, stage: string, kind: string, details: unknown,
    elapsed: number | null = null): PersistedEvent {
    return Object.freeze({ id: crypto.randomUUID(), run_id: runId, fingerprint, created_at: now(), stage, kind,
      elapsed_ms: elapsed, details_json: JSON.stringify(details) });
  }

  async putRawStream(
    runId: string,
    fingerprint: string,
    body: ReadableStream<Uint8Array>,
    key: string
  ): Promise<string> {
    const registration: ArtifactRegistration = Object.freeze({ key, runId, fingerprint, kind: 'vendor_raw_bytes',
      containsText: false, createdAt: now(), registrationToken: crypto.randomUUID() });
    const observations: ArtifactRecovery[] = [];
    await registerArtifact(this.env.DB, registration, observations);
    let operationFailure: { error: unknown } | undefined;
    try {
      await this.createObject(registration, body, undefined);
      await completeArtifact(this.env.DB, registration, observations);
      return key;
    } catch (error) {
      operationFailure = { error }; throw error;
    } finally {
      await this.recordArtifactRecoveries(registration, observations, operationFailure);
    }
  }

  private async recordArtifactRecoveries(
    registration: ArtifactRegistration, observations: ArtifactRecovery[], operationFailure?: { error: unknown }
  ): Promise<void> {
    // Observe recovered D1 failures even if the later R2 operation failed. Observation failures propagate without retry.
    try {
      for (const observation of observations)
        await this.event(registration.runId, registration.fingerprint, 'artifact', 'd1_recovered',
          { key: registration.key, ...observation });
    } catch (error) {
      if (!operationFailure) throw error;
      const primary = failure(operationFailure.error);
      const combined = new ServerFailure(primary.code, primary.kind,
        `${primary.message} The artifact recovery observation could not be recorded.`, primary.status);
      combined.cause = new AggregateError([operationFailure.error, error],
        'Artifact persistence and its recovery observation both failed.');
      throw combined;
    }
  }

  async json<T>(key: string): Promise<T> {
    const written = this.written.get(key);
    if (written !== undefined) return JSON.parse(written) as T;
    return JSON.parse(await this.readObject(key)) as T;
  }

  /** The stored text of an artifact; a documented retryable R2 error repeats the whole read, body included. */
  private async readObject(key: string): Promise<string> {
    const body = await readR2(async () => {
      const object = await this.env.ARTIFACTS.get(key);
      return object ? object.text() : null;
    });
    if (body === null) throw new ServerFailure(
      'E_ARTIFACT_MISSING',
      'blocker',
      'A recorded artifact is missing.'
    );
    return body;
  }

  async text(key: string): Promise<string> {
    const written = this.written.get(key);
    if (written !== undefined) return written;
    return this.readObject(key);
  }

  async event(
    runId: string | null,
    fingerprint: string | null,
    stage: string,
    kind: string,
    details: unknown,
    elapsed: number | null = null
  ): Promise<void> {
    // This invocation owns one immutable row; no caller action is passed to the persistence helper.
    const event = Object.freeze({ id: crypto.randomUUID(), run_id: runId, fingerprint,
      created_at: now(), stage, kind, elapsed_ms: elapsed, details_json: JSON.stringify(details) });
    await appendEvent(this.env.DB, event);
  }

  /**
   * Records one vendor call and adds its charge to the run's spend counters in ONE D1 batch (atomic): the call row and
   * the counters can never disagree by a failed second statement. Role mapping is `vendorSpendDelta` (the same one the
   * full scan sums with); a charge that is not a safe integer of nanodollars is refused loudly, never rounded.
   */
  async recordVendorCall(call: VendorCall, completion?: VendorCallCompletion): Promise<void> {
    await persistVendorCall(this.env.DB, call, completion);
  }

  /** Known spend from the run's counters (one row read). Same numbers as `scanSpend` unless the ledger has drifted. */
  async spendByVendor(runId: string): Promise<Spend> {
    return spendFromRow(await this.run(runId));
  }

  /** Known spend summed from every priced `vendor_calls` row: the full scan, used only for reconciliation. */
  async scanSpend(runId: string): Promise<Spend> {
    const rows = await this.env.DB
      .prepare('SELECT role,cost_nano FROM vendor_calls WHERE run_id=? AND cost_nano IS NOT NULL')
      .bind(runId)
      .all<{ role: string; cost_nano: string }>();
    return sumVendorSpend(rows.results);
  }

  /** Unknown-cost calls counted from `vendor_calls`: the full scan, used only for reconciliation. */
  async scanUnknown(runId: string): Promise<number> {
    return (await this.env.DB
      .prepare(
        'SELECT COUNT(*) AS count FROM vendor_calls WHERE run_id=? AND cost_nano IS NULL'
      )
      .bind(runId)
      .first<{ count: number }>())?.count ?? 0;
  }

  /**
   * Known spend for the results file: the counters, or the full scan once a ledger drift has been recorded on the run
   * (`N_SPEND_LEDGER_DRIFT`). The counters are never overwritten to match; the drift stays visible.
   */
  async spendForResults(runId: string): Promise<Spend> {
    const run = await this.run(runId);
    return runNotesOf(run).includes(SPEND_LEDGER_DRIFT_NOTE) ? this.scanSpend(runId) : spendFromRow(run);
  }

  /** Unknown-cost calls for the results file: the counter, or the full scan once a ledger drift has been recorded. */
  async unaccountedForResults(runId: string): Promise<number> {
    const run = await this.run(runId);
    return runNotesOf(run).includes(SPEND_LEDGER_DRIFT_NOTE) ? this.scanUnknown(runId) : unknownFromRow(run);
  }

  /**
   * Once, when a run reaches `complete` or `halted`: compares the counters with the full scan. Any difference is
   * recorded as the run-level note `N_SPEND_LEDGER_DRIFT` plus an event `spend`/`drift` carrying both value sets. Nothing
   * is corrected. A failure of the comparison itself is recorded as `spend`/`reconcile_failed` and does not propagate:
   * this runs inside the terminal transition, and a bookkeeping check must never displace a halt cause or a completion.
   */
  async reconcileSpend(runId: string): Promise<void> {
    try {
      const run = await this.run(runId);
      const counters = { ...spendFromRow(run), unknownCalls: unknownFromRow(run) };
      const scan = { ...await this.scanSpend(runId), unknownCalls: await this.scanUnknown(runId) };
      const drifted = counters.openai !== scan.openai || counters.typesafe !== scan.typesafe ||
        counters.unknownCalls !== scan.unknownCalls;
      if (!drifted) return;
      const notes = runNotesOf(run);
      if (!notes.includes(SPEND_LEDGER_DRIFT_NOTE)) await this.env.DB
        .prepare('UPDATE runs SET notes_json=? WHERE id=?')
        .bind(JSON.stringify([...notes, SPEND_LEDGER_DRIFT_NOTE]), runId)
        .run();
      await this.event(runId, null, 'spend', 'drift', { counters, scan });
    } catch (error) {
      await this.event(runId, null, 'spend', 'reconcile_failed', {
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'E_INTERNAL',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Document counts for the runs list: how many were uploaded and how many have finished. */
  async runCounts(runId: string): Promise<{ uploaded: number; completed: number }> {
    const row = await this.env.DB
      .prepare(
        "SELECT COUNT(*) AS uploaded,COALESCE(SUM(status='complete'),0) AS completed FROM documents WHERE run_id=?"
      )
      .bind(runId)
      .first<{ uploaded: number; completed: number }>();
    return { uploaded: row?.uploaded ?? 0, completed: row?.completed ?? 0 };
  }

  async spend(runId: string): Promise<string> {
    return (await this.spendByVendor(runId)).blended;
  }

  /** Vendor HTTP attempts whose checkpoint never completed and that recorded no call row: their charge is unknown. */
  async pendingAccounting(runId: string): Promise<number> {
    const calls = await this.env.DB
      .prepare(
        'SELECT COUNT(*) AS count FROM checkpoints c WHERE c.run_id=? AND ' + UNRECEIPTED_HTTP_CHECKPOINT +
        // These denials occur before sending. A reservation, uncertain dispatch or generic storage failure stays pending.
        " AND NOT (c.status='failed' AND c.error_code IS NOT NULL AND c.error_code IN ('E_DAILY_LIMIT','E_DAILY_USAGE_UNKNOWN','E_DAILY_USAGE_BOUND') AND NOT EXISTS(SELECT 1 FROM daily_usage_reservations r WHERE r.attempt_id=" + HTTP_ATTEMPT_ID + "))" +
        " AND NOT EXISTS(SELECT 1 FROM daily_usage_cancellations x JOIN daily_usage_reservations r ON r.attempt_id=x.attempt_id AND r.owner_nonce=x.owner_nonce WHERE x.attempt_id=" + HTTP_ATTEMPT_ID + ")"
      )
      .bind(runId)
      .first<{ count: number }>();
    return calls?.count ?? 0;
  }

  /** Unknown-cost calls from the run's counter (one row read); `scanUnknown` is the full scan. */
  async unaccounted(runId: string): Promise<number> {
    return unknownFromRow(await this.run(runId));
  }

  checkpoints(runId: string, fingerprint: string): CheckpointStore {
    return checkpointPersistence(this.env.DB, runId, fingerprint);
  }

  async halt(runId: string, details: unknown): Promise<void> {
    // Only an exact owned atomic transition receipt can authorize this reconciliation.
    if (await persistRunHalt(this.env.DB, runId, details)) await this.reconcileSpend(runId);
  }

  /**
   * Deletes the run's held text one page at a time: at most CLOSE_PAGE artifacts per call, each one R2 delete plus one
   * D1 update when healthy. The derived query budget also bounds retries/reconciliation under D1's 1,000-query cap.
   * General Workers Paid subrequests have a separate 10,000 default. Returns
   * `{closed:false, remaining}` while text objects remain (the run stays `closing`; the next call continues where this
   * one stopped, and needs no discard body) and `{closed:true}` once the last page is gone and the run is closed.
   */
  async close(runId: string, actor: string): Promise<{ closed: true } | { closed: false; remaining: number }> {
    let operation = 'read_run', activeKey: string | undefined;
    // `cleared`: objects this request removed whose deletion record is confirmed, by its own write or by a peer closer's
    // earlier tombstone. It is the page's progress and the `deleted` figure of its page and failed events, so two
    // overlapping closers may both report the same object. The final state is read from storage either way.
    let spent = 0, cleared = 0;
    try {
    const run = await this.run(runId);
    // Completion and halts compare the spend counters with the recorded calls; a run discarded before it finished passes
    // through neither, so its closure makes that comparison (DECISIONS 140, discarding a run while it is being sorted).
    const finished = run.status === 'complete' || run.status === 'halted';
    const fits = (queries: number) => spent + queries <= CLOSE_DATA_D1_BUDGET;
    const overBudget = () => closureRefusal('query_budget', 'E_CLOSE_QUERY_BUDGET', serverCopy.closeQueryBudget);
    const charge = (queries: number) => {
      if (!Number.isSafeInteger(queries) || queries < 0 || !fits(queries)) throw overBudget();
      spent += queries;
    };
    const removeText = async (key: string) => {
      activeKey = key; operation = 'delete_text';
      await deleteClosedText(this.env.ARTIFACTS, runId, key);
      operation = 'record_text_deletion';
      await persistTextDeletion(this.env.DB, runId, key, charge);
      cleared++;
    };
    const held = async () => {
      operation = 'count_remaining'; activeKey = undefined;
      const result = await readD1<{ count: number; writing: number }>(this.env.DB.prepare("SELECT COUNT(*) AS count,COUNT(CASE WHEN state='writing' THEN 1 END) AS writing FROM artifacts WHERE run_id=? AND contains_text=1 AND deleted_at IS NULL")
        .bind(runId));
      if (!result || !Number.isSafeInteger(result.count) || result.count < 0 || !Number.isSafeInteger(result.writing) || result.writing < 0 || result.writing > result.count)
        throw new ServerFailure('E_STORAGE_D1', 'blocker', 'The count of text objects still held could not be read. The run remains closing.');
      return result;
    };
    const pageEvent = async (remaining: number) => {
      operation = 'record_page';
      if (cleared > 0) await this.event(runId, null, 'closure', 'page', { actor, deleted: cleared, remaining });
    };
    // Text remains for the next page. A page that cleared nothing would be asked for again for ever, so it is refused.
    const partial = (remaining: number) => {
      if (cleared === 0) throw closureRefusal('no_text_removed', 'E_CLOSE_WRITES_PENDING', serverCopy.closeWritesPending);
      return { closed: false as const, remaining };
    };
    operation = 'mark_closing';
    if ((await persistClosureTransition(this.env.DB, runId, 'begin')).closed) return { closed: true };
    operation = 'record_requested';
    await this.event(runId, null, 'closure', 'requested', { actor });
    // Mark closing first: every workflow guard now refuses another vendor call.
    await reconcileTextWrites({
      pendingWrites: async () => (
        await retryTransientRead(() => this.env.DB
          .prepare(
            "SELECT key,created_at FROM artifacts WHERE run_id=? AND contains_text=1 AND state='writing' AND deleted_at IS NULL ORDER BY key LIMIT ?"
          )
          .bind(runId, CLOSE_PENDING_PAGE)
          .all<{ key: string; created_at: string }>(), classifyD1WriteTransient)
      ).results.map(row => ({ key: row.key, registeredAt: row.created_at })),
      exists: async key => {
        if (!fits(CLOSE_PENDING_UNIT_D1_BOUND)) throw overBudget();
        operation = 'check_pending_text'; activeKey = key;
        return !!await readR2(() => this.env.ARTIFACTS.head(key));
      },
      wasRejected: async _key => false, // A rejected binding Promise does not prove that no server write occurred.
      markComplete: async key => {
        // The HEAD confirmed this pending text exists. Closure removes it now, not merely its writing flag, so every
        // bounded reconciliation page makes truthful progress in held-text count before another page is requested.
        await removeText(key);
        charge(CLOSE_EVENT_D1_BOUND); operation = 'record_write_reconciled';
        await this.event(runId, null, 'closure', 'write_reconciled', { key, actor });
      },
      now: () => Date.now(),
      // Released as never written (closure.ts). The key is deleted anyway (harmless when absent); a put that still lands is
      // deleted by `put`'s late-write guard.
      abandon: async (key, ageMs) => {
        await removeText(key);
        charge(CLOSE_EVENT_D1_BOUND); operation = 'record_write_abandoned';
        await this.event(runId, null, 'closure', 'write_abandoned', { key, ageMs, actor });
      },
    });
    const reconciled = await held();
    // No unexamined writing row enters ordinary deletion. A later explicit-close page continues this bounded phase.
    if (reconciled.writing > 0) { await pageEvent(reconciled.count); return partial(reconciled.count); }
    operation = 'read_deletion_page';
    const rows = await retryTransientRead(() => this.env.DB
      .prepare(
        "SELECT key FROM artifacts WHERE run_id=? AND contains_text=1 AND state='complete' AND deleted_at IS NULL ORDER BY key LIMIT ?"
      )
      .bind(runId, CLOSE_PAGE - cleared)
      .all<{ key: string }>(), classifyD1WriteTransient);
    for (const row of rows.results) {
      if (!fits(TEXT_DELETION_D1_QUERY_BOUND)) break;
      await removeText(row.key);
    }
    const left = await held();
    // One event per page so the history shows the deletion's progress.
    await pageEvent(left.count);
    if (left.count > 0) return partial(left.count);
    operation = 'mark_closed';
    const closed = await persistClosureTransition(this.env.DB, runId, 'finish');
    if (!closed.closed) return partial(closed.remaining);
    operation = 'record_completed';
    await this.event(runId, null, 'closure', 'completed', { actor });
    if (!finished) { operation = 'reconcile_spend'; await this.reconcileSpend(runId); }
    return { closed: true };
    } catch (error) {
      const code = error instanceof ServerFailure ? error.code : 'E_INTERNAL';
      // A deliberate refusal names its rule; any other failure names the stage it stopped. A storage error class is
      // recorded only when the D1 or R2 rules recognize the error.
      const errorClass = classifyD1WriteTransient(error) ?? classifyR2Transient(error);
      const details = { actor, operation: refusedRule(error) ?? operation, code, ...(activeKey ? { key: activeKey } : {}),
        deleted: cleared, ...(errorClass === null ? {} : { errorClass }) };
      closureDiagnostic({ scope: 'closure', outcome: 'failed', runId, ...details });
      try { await this.event(runId, null, 'closure', 'failed', details); }
      catch { closureDiagnostic({ operation: 'closure_failure_record', outcome: 'failed', runId, code }); }
      throw error;
    }
  }

  /**
   * The late-write guard: text whose put landed once its run was closing or closed is deleted at once and the write
   * fails with E_RUN_CLOSED (carrying `cause`, the completion failure, when there was one). Otherwise returns.
   */
  private async discardLateText(runId: string, key: string, cause?: unknown): Promise<void> {
    const current = await this.run(runId);
    if (current.status !== 'closing' && current.status !== 'closed') return;
    await deleteClosedText(this.env.ARTIFACTS, runId, key);
    // The first deletion time is kept; a deleted row is never restored.
    await persistTextDeletion(this.env.DB, runId, key);
    const closed = new ServerFailure(
      'E_RUN_CLOSED',
      'blocker',
      'The run closed while text was being stored. The late text write was deleted.'
    );
    if (cause !== undefined) closed.cause = cause;
    throw closed;
  }
}
